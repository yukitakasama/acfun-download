//! AcFun 下载 · 启动器
//!
//! 用户双击桌面/开始菜单图标时跑的就是它。行为刻意做到「零原生 UI」：
//!   1. 读 `%APPDATA%\acfun-download\server.json`；若里面的服务还活着（健康检查通过）→ 直接开浏览器
//!   2. 否则用同目录的 node.exe 拉起本地服务（`CREATE_NO_WINDOW`，后台跑）
//!   3. 等 service 把运行信息（随机端口 + 一次性 token）写进 server.json，再打开默认浏览器
//!   4. 自身立即退出 —— 不常驻、不留窗口；服务由网页里的「退出服务」按钮关停
//!
//! 只用标准库：不引第三方 crate，编译产物只有几十 KB，build 不需要联网。

#![windows_subsystem = "windows"]

use std::env;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread::sleep;
use std::time::{Duration, Instant};

const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[link(name = "user32")]
extern "system" {
    fn MessageBoxW(hwnd: *mut u16, text: *const u16, caption: *const u16, utype: u32) -> i32;
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

fn alert(msg: &str) {
    // 自动化/排障时用 ACFUN_NO_ALERT=1：写文件而不是弹模态框（模态框会卡住脚本）
    if env::var("ACFUN_NO_ALERT").as_deref() == Ok("1") {
        let path = state_file_path().with_file_name("launcher-error.txt");
        let _ = fs::write(path, msg);
        return;
    }
    let text = wide(msg);
    let caption = wide("AcFun 下载");
    unsafe {
        MessageBoxW(std::ptr::null_mut(), text.as_ptr(), caption.as_ptr(), 0x0000_0040);
    }
}

/// `%APPDATA%\acfun-download\server.json`（与 CLI/服务端同一位置）。
fn state_file_path() -> PathBuf {
    let appdata = env::var("APPDATA").unwrap_or_else(|_| {
        let home = env::var("USERPROFILE").unwrap_or_else(|_| "C:\\".into());
        format!("{home}\\AppData\\Roaming")
    });
    let dir = Path::new(&appdata).join("acfun-download");
    let _ = fs::create_dir_all(&dir);
    dir.join("server.json")
}

fn log_path() -> PathBuf {
    state_file_path().with_file_name("server.log")
}

/// 极简 JSON 取值：够用即可（只读我们自己写的那份）。
fn json_str<'a>(text: &'a str, key: &str) -> Option<&'a str> {
    let pat = format!("\"{key}\"");
    let i = text.find(&pat)?;
    let rest = &text[i + pat.len()..];
    let colon = rest.find(':')?;
    let rest = rest[colon + 1..].trim_start();
    let rest = rest.strip_prefix('"')?;
    let end = rest.find('"')?;
    Some(&rest[..end])
}

fn json_num(text: &str, key: &str) -> Option<u16> {
    let pat = format!("\"{key}\"");
    let i = text.find(&pat)?;
    let rest = &text[i + pat.len()..];
    let colon = rest.find(':')?;
    let rest = rest[colon + 1..].trim_start();
    let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
    digits.parse::<u16>().ok()
}

/// 原始 HTTP GET（不引 HTTP 库）：只关心能不能拿到 200。
fn health_ok(port: u16) -> bool {
    let addr = format!("127.0.0.1:{port}");
    let sock = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    let mut stream = match TcpStream::connect_timeout(&sock, Duration::from_millis(600)) {
        Ok(s) => s,
        Err(_) => return false,
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(1200)));
    let req = format!("GET /api/health HTTP/1.1\r\nHost: {addr}\r\nConnection: close\r\n\r\n");
    if stream.write_all(req.as_bytes()).is_err() {
        return false;
    }
    let mut buf = [0u8; 256];
    let n = match stream.read(&mut buf) {
        Ok(n) => n,
        Err(_) => return false,
    };
    String::from_utf8_lossy(&buf[..n]).starts_with("HTTP/1.1 200") || String::from_utf8_lossy(&buf[..n]).starts_with("HTTP/1.0 200")
}

/// 让正在跑的服务优雅退出（卸载程序与「退出服务」都走这条）。
fn request_shutdown(port: u16, token: &str) -> bool {
    let sock = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    let mut stream = match TcpStream::connect_timeout(&sock, Duration::from_millis(800)) {
        Ok(s) => s,
        Err(_) => return false,
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(2000)));
    let req = format!(
        "POST /api/shutdown HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nX-Acfun-Token: {token}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
    );
    if stream.write_all(req.as_bytes()).is_err() {
        return false;
    }
    let mut buf = [0u8; 128];
    let _ = stream.read(&mut buf);
    // 等端口真的关掉
    let deadline = Instant::now() + Duration::from_secs(6);
    while Instant::now() < deadline {
        sleep(Duration::from_millis(200));
        if !health_ok(port) {
            return true;
        }
    }
    false
}

fn read_state(path: &Path) -> Option<(u16, String)> {
    let text = fs::read_to_string(path).ok()?;
    let port = json_num(&text, "port")?;
    let token = json_str(&text, "token")?.to_string();
    if port == 0 || token.is_empty() {
        return None;
    }
    Some((port, token))
}

fn open_browser(url: &str) {
    // `start "" <url>`：交给系统默认浏览器；空标题参数不能省（否则带引号的 URL 会被当成标题）
    let mut cmd = Command::new("cmd");
    cmd.args(["/c", "start", "", url])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let _ = cmd.spawn();
}

fn spawn_server(app_dir: &Path, state: &Path) -> Result<(), String> {
    let node = app_dir.join("node.exe");
    let js = app_dir.join("server").join("index.js");
    let web = app_dir.join("web");
    if !node.exists() {
        return Err(format!("缺少 node.exe（应用安装不完整）：\n{}", node.display()));
    }
    if !js.exists() {
        return Err(format!("缺少服务端文件：\n{}", js.display()));
    }
    if !web.join("index.html").exists() {
        return Err(format!("缺少前端资源：\n{}", web.display()));
    }

    // 服务日志落到 %APPDATA%\acfun-download\server.log，方便排查
    let log_out = OpenOptions::new().create(true).append(true).open(log_path()).ok();
    let log_err = log_out.as_ref().and_then(|f| f.try_clone().ok());

    let mut cmd = Command::new(&node);
    cmd.arg(&js)
        .arg("--port")
        .arg("0")
        .arg("--web-dir")
        .arg(&web)
        .arg("--state-file")
        .arg(state)
        .arg("--no-handshake")
        .current_dir(app_dir)
        .stdin(Stdio::null());
    match log_out {
        Some(f) => cmd.stdout(Stdio::from(f)),
        None => cmd.stdout(Stdio::null()),
    };
    match log_err {
        Some(f) => cmd.stderr(Stdio::from(f)),
        None => cmd.stderr(Stdio::null()),
    };
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd.spawn().map_err(|e| format!("启动本地服务失败：{e}"))?;
    Ok(())
}

fn main() {
    let exe = env::current_exe().unwrap_or_default();
    let app_dir = exe.parent().map(Path::to_path_buf).unwrap_or_default();
    let state = state_file_path();

    // `AcFunDownload.exe --shutdown`：给卸载程序/脚本用，停掉后台服务后退出
    if env::args().any(|a| a == "--shutdown") {
        if let Some((port, token)) = read_state(&state) {
            let _ = request_shutdown(port, &token);
        }
        return;
    }

    // 1) 已有服务在跑 → 直接开浏览器
    if let Some((port, token)) = read_state(&state) {
        if health_ok(port) {
            let url = format!("http://127.0.0.1:{port}/?token={token}");
            if env::var("ACFUN_NO_BROWSER").as_deref() != Ok("1") {
                open_browser(&url);
            } else {
                let _ = File::create(state.with_file_name("launcher-would-open.txt"))
                    .and_then(|mut f| f.write_all(url.as_bytes()));
            }
            return;
        }
        // 状态文件过期（服务被强杀过）：删掉重来
        let _ = fs::remove_file(&state);
    }

    // 2) 拉起服务
    if let Err(e) = spawn_server(&app_dir, &state) {
        alert(&e);
        return;
    }

    // 3) 等它把运行信息写出来（正常 1s 内；冷启动不超过 20s）
    let deadline = Instant::now() + Duration::from_secs(20);
    let mut last_err = String::from("本地服务启动超时（20s 内没有就绪）。详见 %APPDATA%\\acfun-download\\server.log");
    while Instant::now() < deadline {
        sleep(Duration::from_millis(250));
        if let Some((port, token)) = read_state(&state) {
            if health_ok(port) {
                let url = format!("http://127.0.0.1:{port}/?token={token}");
                if env::var("ACFUN_NO_BROWSER").as_deref() != Ok("1") {
                    open_browser(&url);
                } else {
                    let _ = File::create(state.with_file_name("launcher-would-open.txt"))
                        .and_then(|mut f| f.write_all(url.as_bytes()));
                }
                return;
            }
            last_err = format!("本地服务端口 {port} 无响应。详见 %APPDATA%\\acfun-download\\server.log");
        }
    }
    alert(&last_err);
}
