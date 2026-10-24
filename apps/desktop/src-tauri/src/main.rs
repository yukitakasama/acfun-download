//! Tauri 2 桌面壳（PLAN §3.1 / M7）。
//!
//! 职责很窄，业务全在 node sidecar 里：
//!   1. 启动时拉起 `acfun-server`（= 内嵌的 node.exe + 单文件 JS bundle）
//!   2. 读它 stdout 首行的握手 JSON（随机端口 + 一次性 token），据此创建窗口加载 GUI
//!   3. 托盘常驻、单实例（再次双击只聚焦已有窗口）
//!   4. 退出时把 sidecar 整棵进程树杀掉（连同 ffmpeg/ego 子进程），不留残余 node 进程
//!
//! 注意：本机缺 Rust + MSVC 时**无法编译**，属计划内已知阻塞（PLAN §2 / §10）。

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// 与 node 侧握手的第一行 JSON。
#[derive(Debug, serde::Deserialize)]
struct Handshake {
    #[serde(rename = "type")]
    kind: String,
    port: u16,
    token: String,
    url: String,
    pid: u32,
}

struct SidecarState {
    child: Mutex<Option<Child>>,
    pid: Mutex<Option<u32>>,
}

impl SidecarState {
    fn new() -> Self {
        Self {
            child: Mutex::new(None),
            pid: Mutex::new(None),
        }
    }
}

/// sidecar 可执行文件位置：打包后与主程序同目录（externalBin），
/// 开发时在 `src-tauri/binaries/acfun-server-<triple>.exe`。
fn resolve_sidecar_exe() -> Result<PathBuf, String> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("acfun-server.exe"));
            candidates.push(dir.join("acfun-server"));
        }
    }
    candidates.push(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("binaries")
            .join("acfun-server-x86_64-pc-windows-msvc.exe"),
    );
    for c in candidates {
        if c.exists() {
            return Ok(c);
        }
    }
    Err("找不到 sidecar 可执行文件（先跑 pnpm --filter @acfun/desktop prepare:sidecar）".into())
}

/// server 的单文件 bundle 由 resources 带进来。
fn resolve_server_js(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .resource_dir()
        .map_err(|e| format!("取 resource_dir 失败: {e}"))?;
    let js = dir.join("resources").join("server").join("index.js");
    if js.exists() {
        return Ok(js);
    }
    // 开发模式：直接在仓库里找
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("resources")
        .join("server")
        .join("index.js");
    if dev.exists() {
        return Ok(dev);
    }
    Err(format!("找不到 server bundle: {}", js.display()))
}

/// 前端静态资源目录（resources/web）。
fn resolve_web_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    if let Ok(dir) = app.path().resource_dir() {
        let web = dir.join("resources").join("web");
        if web.join("index.html").exists() {
            return Ok(web);
        }
    }
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("resources")
        .join("web");
    if dev.join("index.html").exists() {
        return Ok(dev);
    }
    Err("找不到前端产物（先跑 pnpm --filter @acfun/desktop prepare:sidecar）".into())
}

/// 拉起 sidecar 并读握手。stderr 转后台线程原样打到控制台（dev）/ 丢弃（release）。
fn spawn_sidecar(app: &tauri::AppHandle) -> Result<Handshake, String> {
    let exe = resolve_sidecar_exe()?;
    let js = resolve_server_js(app)?;
    let web = resolve_web_dir(app)?;

    let mut cmd = Command::new(&exe);
    cmd.arg(&js)
        .arg("--port")
        .arg("0")
        // GUI 由 sidecar 自己伺服（端口随机、token 一次性），所以必须显式给目录
        .arg("--web-dir")
        .arg(&web)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("启动 sidecar 失败: {e}"))?;

    let stdout = child.stdout.take().ok_or("sidecar stdout 不可用")?;
    let mut reader = BufReader::new(stdout);
    let mut first = String::new();
    reader
        .read_line(&mut first)
        .map_err(|e| format!("读取握手失败: {e}"))?;

    if let Some(stderr) = child.stderr.take() {
        std::thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines().map_while(Result::ok) {
                eprintln!("[sidecar] {line}");
            }
        });
    }
    // 握手之后 stdout 还会继续输出（一般没有），这里丢弃即可
    std::thread::spawn(move || {
        for _ in reader.lines() {}
    });

    let hs: Handshake = serde_json::from_str(first.trim())
        .map_err(|e| format!("握手解析失败（收到 {:?}）: {e}", first.trim()))?;
    if hs.kind != "server" {
        return Err(format!("握手类型异常: {}", hs.kind));
    }

    let state = app.state::<SidecarState>();
    *state.pid.lock().unwrap() = Some(hs.pid);
    *state.child.lock().unwrap() = Some(child);
    Ok(hs)
}

/// 退出清理：优先 taskkill 整棵树（连 ffmpeg / ego 子进程一起收掉）。
fn kill_sidecar_tree(pid: Option<u32>, child: Option<Child>) {
    #[cfg(windows)]
    if let Some(pid) = pid {
        let _ = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    if let Some(mut child) = child {
        let _ = child.kill();
        let _ = child.wait();
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            // 再次双击：聚焦已有窗口，不新起服务
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.show();
                let _ = win.unminimize();
                let _ = win.set_focus();
            }
        }))
        .manage(SidecarState::new())
        .setup(|app| {
            let hs = spawn_sidecar(app.handle())?;
            let url = hs
                .url
                .parse()
                .map_err(|e| format!("GUI url 非法（{}）: {e}", hs.url))?;

            // 端口是随机的、token 是一次性的，所以窗口必须运行时创建
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
                .title("AcFun 视频下载")
                .inner_size(1120.0, 860.0)
                .min_inner_size(880.0, 600.0)
                .build()?;

            // 托盘：显示 / 退出
            let show = MenuItem::with_id(app, "show", "显示窗口", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;
            let _tray = TrayIconBuilder::with_id("main")
                .icon(app.default_window_icon().cloned().ok_or("缺少默认图标")?)
                .tooltip("AcFun 视频下载")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(win) = app.get_webview_window("main") {
                            let _ = win.show();
                            let _ = win.set_focus();
                        }
                    }
                    "quit" => {
                        let state = app.state::<SidecarState>();
                        let pid = *state.pid.lock().unwrap();
                        let child = state.child.lock().unwrap().take();
                        kill_sidecar_tree(pid, child);
                        app.exit(0);
                    }
                    _ => {}
                })
                .build(app)?;

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Tauri 应用初始化失败")
        .run(|app, event| {
            if let RunEvent::ExitRequested { .. } | RunEvent::Exit = event {
                // 关闭窗口/退出主循环时收掉 sidecar，避免残留 node 进程（M7 验收项）
                let state = app.state::<SidecarState>();
                let pid = *state.pid.lock().unwrap();
                let child = state.child.lock().unwrap().take();
                kill_sidecar_tree(pid, child);
            }
        });
}
