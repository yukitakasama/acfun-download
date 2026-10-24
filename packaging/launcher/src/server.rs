//! 本地服务（node 进程）的发现 / 拉起 / 关停。
//!
//! GUI 只是客户端，真正的下载逻辑在 `server/index.js`（随包分发的 node.exe 跑）。
//! 这里保留「先找已有实例，否则拉起」的策略：重复打开应用不会起第二个服务。

use std::env;
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread::sleep;
use std::time::{Duration, Instant};

const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Clone, Debug)]
pub struct ServiceInfo {
    pub port: u16,
    pub token: String,
    /// true = 本次由 GUI 拉起（退出时负责关掉）；false = 复用别人已经跑着的实例
    pub spawned: bool,
}

pub fn state_file() -> PathBuf {
    app_data_dir().join("server.json")
}

pub fn log_file() -> PathBuf {
    app_data_dir().join("server.log")
}

fn app_data_dir() -> PathBuf {
    let base = env::var("APPDATA").unwrap_or_else(|_| {
        let home = env::var("USERPROFILE").unwrap_or_else(|_| "C:\\".into());
        format!("{home}\\AppData\\Roaming")
    });
    let dir = Path::new(&base).join("acfun-download");
    let _ = fs::create_dir_all(&dir);
    dir
}

/// 极简 JSON 取值（只读我们自己写的那份 server.json）。
fn json_str<'a>(text: &'a str, key: &str) -> Option<&'a str> {
    let pat = format!("\"{key}\"");
    let i = text.find(&pat)?;
    let rest = &text[i + pat.len()..];
    let rest = rest[rest.find(':')? + 1..].trim_start();
    let rest = rest.strip_prefix('"')?;
    Some(&rest[..rest.find('"')?])
}

fn json_num(text: &str, key: &str) -> Option<u16> {
    let pat = format!("\"{key}\"");
    let i = text.find(&pat)?;
    let rest = &text[i + pat.len()..];
    let rest = rest[rest.find(':')? + 1..].trim_start();
    let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
    digits.parse::<u16>().ok()
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

fn connect(port: u16, timeout: Duration) -> Option<TcpStream> {
    TcpStream::connect_timeout(&SocketAddr::from(([127, 0, 0, 1], port)), timeout).ok()
}

/// 只要 `/api/health` 返回 200 就算活着。
pub fn health_ok(port: u16) -> bool {
    let Some(mut stream) = connect(port, Duration::from_millis(600)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(1500)));
    let req =
        format!("GET /api/health HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
    if stream.write_all(req.as_bytes()).is_err() {
        return false;
    }
    let mut buf = [0u8; 64];
    let Ok(n) = stream.read(&mut buf) else {
        return false;
    };
    let head = String::from_utf8_lossy(&buf[..n]);
    head.starts_with("HTTP/1.1 200") || head.starts_with("HTTP/1.0 200")
}

/// 让正在跑的服务优雅退出（点窗口关闭 / 卸载程序都走这条）。
pub fn request_shutdown(port: u16, token: &str) -> bool {
    let Some(mut stream) = connect(port, Duration::from_millis(800)) else {
        return true;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(2000)));
    let req = format!(
        "POST /api/shutdown HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nX-Acfun-Token: {token}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
    );
    if stream.write_all(req.as_bytes()).is_err() {
        return false;
    }
    let mut buf = [0u8; 64];
    let _ = stream.read(&mut buf);
    let deadline = Instant::now() + Duration::from_secs(6);
    while Instant::now() < deadline {
        sleep(Duration::from_millis(150));
        if !health_ok(port) {
            return true;
        }
    }
    false
}

fn spawn_node(app_dir: &Path, state: &Path) -> Result<(), String> {
    let node = app_dir.join("node.exe");
    let js = app_dir.join("server").join("index.js");
    let web = app_dir.join("web");
    if !node.exists() {
        return Err(format!("应用不完整：缺少 {}\n请重新安装。", node.display()));
    }
    if !js.exists() {
        return Err(format!("应用不完整：缺少 {}\n请重新安装。", js.display()));
    }
    if !web.join("index.html").exists() {
        return Err(format!(
            "应用不完整：缺少前端资源 {}\n请重新安装。",
            web.display()
        ));
    }

    let log_out = OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_file())
        .ok();
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
    cmd.stdout(match log_out {
        Some(f) => Stdio::from(f),
        None => Stdio::null(),
    });
    cmd.stderr(match log_err {
        Some(f) => Stdio::from(f),
        None => Stdio::null(),
    });
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd.spawn().map_err(|e| format!("启动本地服务失败：{e}"))?;
    Ok(())
}

/// 确保服务可用：优先复用已有实例，否则拉起并等待就绪。
pub fn ensure(app_dir: &Path) -> Result<ServiceInfo, String> {
    let state = state_file();
    if let Some((port, token)) = read_state(&state) {
        if health_ok(port) {
            return Ok(ServiceInfo {
                port,
                token,
                spawned: false,
            });
        }
        let _ = fs::remove_file(&state);
    }
    spawn_node(app_dir, &state)?;

    let deadline = Instant::now() + Duration::from_secs(25);
    let mut last = String::from("本地服务启动超时（25s 内没有就绪）。");
    while Instant::now() < deadline {
        sleep(Duration::from_millis(200));
        if let Some((port, token)) = read_state(&state) {
            if health_ok(port) {
                return Ok(ServiceInfo {
                    port,
                    token,
                    spawned: true,
                });
            }
            last = format!("本地服务端口 {port} 无响应。");
        }
    }
    Err(format!(
        "{last}\n日志：{}\n常见原因：杀毒软件拦截 node.exe，或安装目录不完整。",
        log_file().display()
    ))
}

pub fn app_dir() -> PathBuf {
    env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(Path::to_path_buf))
        .unwrap_or_default()
}

fn no_window(cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
}

pub fn open_browser(url: &str) {
    let mut cmd = Command::new("cmd");
    cmd.args(["/c", "start", "", url])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    no_window(&mut cmd);
    let _ = cmd.spawn();
}

pub fn open_folder(path: &Path) {
    let mut cmd = Command::new("explorer");
    cmd.arg(path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    no_window(&mut cmd);
    let _ = cmd.spawn();
}

pub fn reveal_file(path: &Path) {
    let mut cmd = Command::new("explorer");
    cmd.arg(format!("/select,{}", path.display()))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    no_window(&mut cmd);
    let _ = cmd.spawn();
}

pub fn open_path_default(path: &Path) {
    let mut cmd = Command::new("cmd");
    cmd.args(["/c", "start", ""]).arg(path);
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    no_window(&mut cmd);
    let _ = cmd.spawn();
}

/// 弹一个系统消息框（启动失败等致命错误）。
pub fn message_box(title: &str, text: &str) {
    let wide = |s: &str| -> Vec<u16> { s.encode_utf16().chain(std::iter::once(0)).collect() };
    let t = wide(text);
    let c = wide(title);
    unsafe {
        MessageBoxW(std::ptr::null_mut(), t.as_ptr(), c.as_ptr(), 0x0000_0040);
    }
}

#[link(name = "user32")]
extern "system" {
    fn MessageBoxW(hwnd: *mut u16, text: *const u16, caption: *const u16, utype: u32) -> i32;
}
