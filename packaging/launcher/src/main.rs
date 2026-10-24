//! AcFun 下载 · 原生桌面 GUI（Rust + egui）
//!
//! 结构：本程序只是「客户端 + 服务管理器」，下载逻辑仍在随包分发的 node 服务里
//! （`server/index.js`），所以 CLI、WebUI、桌面 GUI 三条入口共用同一套实现。
//!
//! 命令行：
//!   AcFunDownload.exe               打开桌面窗口（默认）
//!   AcFunDownload.exe --webui       不窗口，直接用浏览器打开 WebUI（调试用）
//!   AcFunDownload.exe --shutdown    停掉后台服务（卸载程序/脚本用）

#![windows_subsystem = "windows"]

mod api;
mod app;
mod server;
mod theme;
mod widgets;

use std::time::Duration;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let app_dir = server::app_dir();

    if args.iter().any(|a| a == "--shutdown") {
        if let Some((port, token)) = read_state_for_shutdown() {
            let _ = server::request_shutdown(port, &token);
        }
        return;
    }

    // 无窗口自检：字体/服务/接口是否都好（给打包脚本与排障用，方便脚本化验收）
    if args.iter().any(|a| a == "--check") {
        let (ok, report) = run_check(&app_dir);
        let out = std::env::var("ACFUN_CHECK_OUT")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|_| std::env::temp_dir().join("acfun-gui-check.json"));
        if let Some(parent) = out.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = std::fs::write(&out, format!("{}\n", report));
        std::process::exit(if ok { 0 } else { 1 });
    }

    if args.iter().any(|a| a == "--webui") {
        match server::ensure(&app_dir) {
            Ok(info) => {
                let url = format!("http://127.0.0.1:{}/?token={}", info.port, info.token);
                // ACFUN_NO_BROWSER=1：只把 URL 写到文件里，不开浏览器（自动化/CI 用）
                if std::env::var("ACFUN_NO_BROWSER").as_deref() == Ok("1") {
                    let path = server::state_file().with_file_name("webui-url.txt");
                    let _ = std::fs::write(
                        path,
                        format!(
                            "{url}
"
                        ),
                    );
                } else {
                    server::open_browser(&url);
                }
            }
            Err(e) => server::message_box("AcFun 下载", &e),
        }
        return;
    }

    let boot = server::ensure(&app_dir);

    let options = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default()
            .with_title("AcFun 视频下载")
            .with_inner_size([1100.0, 760.0])
            .with_min_inner_size([960.0, 620.0])
            .with_app_id("acfun-download"),
        vsync: true,
        ..Default::default()
    };

    let run = eframe::run_native(
        "AcFun 视频下载",
        options,
        Box::new(move |cc| Ok(Box::new(app::App::new(cc, boot)))),
    );

    if let Err(e) = run {
        server::message_box("AcFun 下载", &format!("界面启动失败：{e}"));
    }

    // 窗口关闭后稍等一会儿，让 App::drop 里的 shutdown 请求发出去
    std::thread::sleep(Duration::from_millis(50));
}

fn read_state_for_shutdown() -> Option<(u16, String)> {
    let text = std::fs::read_to_string(server::state_file()).ok()?;
    let port = field_num(&text, "port")?;
    let token = field_str(&text, "token")?;
    Some((port, token))
}

fn field_str(text: &str, key: &str) -> Option<String> {
    let pat = format!("\"{key}\"");
    let i = text.find(&pat)?;
    let rest = &text[i + pat.len()..];
    let rest = rest[rest.find(':')? + 1..].trim_start();
    let rest = rest.strip_prefix('"')?;
    Some(rest[..rest.find('"')?].to_string())
}

fn field_num(text: &str, key: &str) -> Option<u16> {
    let pat = format!("\"{key}\"");
    let i = text.find(&pat)?;
    let rest = &text[i + pat.len()..];
    let rest = rest[rest.find(':')? + 1..].trim_start();
    let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
    digits.parse().ok()
}

/// 无窗口自检：中文能否渲染、服务能否拉起、三个只读接口是否可用。
fn run_check(app_dir: &std::path::Path) -> (bool, String) {
    let mut report = serde_json::Map::new();
    let mut ok = true;

    report.insert("version".into(), env!("CARGO_PKG_VERSION").into());
    match crate::theme::cjk_font_path() {
        Some(path) => {
            report.insert("font".into(), path.display().to_string().into());
        }
        None => {
            ok = false;
            report.insert("font".into(), "未找到系统中文字体".into());
        }
    }

    let ctx = egui::Context::default();
    crate::theme::apply(&ctx);
    // 字体是「首帧才构建」的：跑一个空帧再问字形，否则会 panic
    let mut glyphs = false;
    let input = egui::RawInput {
        screen_rect: Some(egui::Rect::from_min_size(
            egui::Pos2::ZERO,
            egui::vec2(800.0, 600.0),
        )),
        ..Default::default()
    };
    let _ = ctx.run(input, |ctx| {
        glyphs = ctx.fonts(|f| {
            f.has_glyphs(
                &egui::FontId::proportional(14.0),
                "中文测试核验速度失败完成",
            )
        });
    });
    report.insert("cjkGlyphs".into(), glyphs.into());
    if !glyphs {
        ok = false;
    }

    match server::ensure(app_dir) {
        Ok(info) => {
            report.insert("port".into(), info.port.into());
            report.insert("spawned".into(), info.spawned.into());
            let client = api::Client::new(info.port, info.token.clone());
            for (name, path) in [
                ("health", "/api/health"),
                ("config", "/api/config"),
                ("tasks", "/api/tasks"),
            ] {
                match client.get(path) {
                    Ok(v) => {
                        report.insert(
                            format!("{name}Ok"),
                            v.get("ok")
                                .and_then(|x| x.as_bool())
                                .unwrap_or(false)
                                .into(),
                        );
                    }
                    Err(e) => {
                        ok = false;
                        report.insert(format!("{name}Ok"), false.into());
                        report.insert(format!("{name}Error"), e.into());
                    }
                }
            }
            if info.spawned {
                let _ = server::request_shutdown(info.port, &info.token);
            }
        }
        Err(e) => {
            ok = false;
            report.insert("serviceError".into(), e.into());
        }
    }

    report.insert("ok".into(), ok.into());
    (ok, serde_json::Value::Object(report).to_string())
}
