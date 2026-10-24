//! 主窗口：顶栏 / 输入 / 任务队列 / 设置侧栏 / 底栏 / 提示。
//!
//! 视觉上刻意做成「一个窗口办完所有事」：不弹网页、不跳页面，
//! 左边干活（粘链接、看进度），右边调参数。

use std::sync::mpsc::{channel, Receiver};
use std::time::{Duration, Instant};

use egui::{
    Align, Align2, Color32, FontId, Frame, Layout, Margin, RichText, Rounding, ScrollArea, Sense,
    Stroke, TextEdit, TextStyle, Ui, Vec2,
};

use crate::api::{Cmd, Config, EnvState, Level, Msg, ParseInfo, Stats, TaskView, Worker};
use crate::server::{self, ServiceInfo};
use crate::theme::*;
use crate::widgets::{self, Btn};

pub const APP_VERSION: &str = env!("CARGO_PKG_VERSION");

struct Toast {
    text: String,
    level: Level,
    at: Instant,
}

#[derive(Clone)]
struct Line {
    text: String,
    level: Level,
    at: Instant,
}

enum Action {
    Cancel(String),
    Retry(String),
    Open(String),
    Reveal(String),
}

pub struct App {
    boot_error: Option<String>,
    booting: bool,
    boot_rx: Option<Receiver<Result<ServiceInfo, String>>>,
    worker: Option<Worker>,
    service: Option<ServiceInfo>,

    tasks: Vec<TaskView>,
    stats: Stats,
    config: Option<Config>,
    form: Option<Config>,
    env: EnvState,

    input: String,
    parse: Option<ParseInfo>,
    parsing: bool,
    submitting: bool,

    show_settings: bool,
    settings_dirty: bool,
    saved_at: Option<Instant>,

    toasts: Vec<Toast>,
    activity: Vec<Line>,
    last_status: Vec<(String, String)>,
    offline: Option<String>,
    confirm_exit: bool,
    show_activity: bool,
    pending_action: Option<Action>,
}

impl App {
    pub fn new(cc: &eframe::CreationContext<'_>, boot: Result<ServiceInfo, String>) -> Self {
        crate::theme::apply(&cc.egui_ctx);
        let mut app = Self {
            boot_error: None,
            booting: false,
            boot_rx: None,
            worker: None,
            service: None,
            tasks: Vec::new(),
            stats: Stats::default(),
            config: None,
            form: None,
            env: EnvState::default(),
            input: String::new(),
            parse: None,
            parsing: false,
            submitting: false,
            // ACFUN_GUI_OPEN_SETTINGS=1：启动就展开设置（截图/QA 用）
            show_settings: std::env::var("ACFUN_GUI_OPEN_SETTINGS")
                .map(|v| v == "1")
                .unwrap_or(false),
            settings_dirty: false,
            saved_at: None,
            toasts: Vec::new(),
            activity: Vec::new(),
            last_status: Vec::new(),
            offline: None,
            confirm_exit: false,
            show_activity: false,
            pending_action: None,
        };
        app.attach(boot);
        app
    }

    fn attach(&mut self, boot: Result<ServiceInfo, String>) {
        match boot {
            Ok(info) => {
                self.service = Some(info.clone());
                let worker = crate::api::spawn(info.port, info.token.clone());
                let _ = worker.tx.send(Cmd::LoadConfig);
                let _ = worker.tx.send(Cmd::LoadEnv);
                self.worker = Some(worker);
                self.boot_error = None;
                if info.spawned {
                    self.push("本地服务已就绪".into(), Level::Good);
                } else {
                    self.push("已接入正在运行的本地服务".into(), Level::Info);
                }
            }
            Err(e) => {
                self.boot_error = Some(e);
                self.worker = None;
            }
        }
    }

    fn push(&mut self, text: String, level: Level) {
        self.activity.push(Line {
            text: text.clone(),
            level,
            at: Instant::now(),
        });
        if self.activity.len() > 200 {
            self.activity.remove(0);
        }
        self.toasts.push(Toast {
            text,
            level,
            at: Instant::now(),
        });
        if self.toasts.len() > 4 {
            self.toasts.remove(0);
        }
    }

    fn send(&mut self, cmd: Cmd) {
        if let Some(w) = &self.worker {
            let _ = w.tx.send(cmd);
        }
    }

    fn retry_boot(&mut self) {
        if self.booting {
            return;
        }
        self.booting = true;
        self.boot_error = None;
        let (tx, rx) = channel();
        self.boot_rx = Some(rx);
        std::thread::spawn(move || {
            let res = server::ensure(&server::app_dir());
            let _ = tx.send(res);
        });
    }

    fn drain(&mut self) {
        if let Some(rx) = &self.boot_rx {
            if let Ok(res) = rx.try_recv() {
                self.booting = false;
                self.boot_rx = None;
                self.attach(res);
            }
        }

        let mut msgs: Vec<Msg> = Vec::new();
        if let Some(w) = &self.worker {
            while let Ok(m) = w.rx.try_recv() {
                msgs.push(m);
            }
        }
        for m in msgs {
            match m {
                Msg::Tasks(tasks, stats) => {
                    // 状态迁移写进「最近动态」，相当于一个轻量日志
                    for t in &tasks {
                        let prev = self
                            .last_status
                            .iter()
                            .find(|(id, _)| *id == t.id)
                            .map(|(_, s)| s.clone());
                        if prev.as_deref() != Some(t.status.as_str())
                            && matches!(
                                t.status.as_str(),
                                "done" | "failed" | "canceled" | "skipped"
                            )
                        {
                            let (txt, lv) = match t.status.as_str() {
                                "done" => (format!("完成：{}", t.label()), Level::Good),
                                "failed" => (format!("失败：{}", t.label()), Level::Bad),
                                "canceled" => (format!("已取消：{}", t.label()), Level::Warn),
                                _ => (format!("跳过：{}", t.label()), Level::Warn),
                            };
                            self.push(txt, lv);
                        }
                    }
                    self.last_status = tasks
                        .iter()
                        .map(|t| (t.id.clone(), t.status.clone()))
                        .collect();
                    self.tasks = tasks;
                    self.stats = stats;
                    if self.offline.is_some() {
                        self.offline = None;
                        self.push("已恢复与本地服务的连接".into(), Level::Good);
                    }
                }
                Msg::Config(cfg) => {
                    self.form = Some(cfg.clone());
                    self.config = Some(cfg);
                    self.settings_dirty = false;
                }
                Msg::Env(env) => self.env = env,
                Msg::Parsed(info) => {
                    self.parsing = false;
                    self.parse = Some(info);
                }
                Msg::Submitted { created, skipped } => {
                    self.submitting = false;
                    if created > 0 {
                        self.push(format!("已加入 {created} 条任务"), Level::Good);
                    }
                    if let Some(reason) = skipped.first() {
                        self.push(
                            format!("跳过 {} 条（{reason}）", skipped.len()),
                            Level::Warn,
                        );
                    }
                    self.input.clear();
                    self.parse = None;
                }
                Msg::Note(text, level) => self.push(text, level),
                Msg::Offline(err) => {
                    if self.offline.is_none() {
                        self.offline = Some(err);
                        self.push("与本地服务的连接中断".into(), Level::Bad);
                    }
                }
                Msg::Online => {}
            }
        }
    }

    fn connected(&self) -> bool {
        self.worker.is_some() && self.offline.is_none()
    }

    fn do_submit(&mut self) {
        let text = self.input.trim().to_string();
        if text.is_empty() || self.submitting || !self.connected() {
            return;
        }
        self.submitting = true;
        self.send(Cmd::Submit(text));
    }

    fn do_parse(&mut self) {
        let first = self
            .input
            .lines()
            .map(str::trim)
            .find(|l| !l.is_empty() && !l.starts_with('#') && !l.starts_with("//"))
            .map(str::to_string);
        let Some(first) = first else {
            self.push("先粘贴一个链接再解析".into(), Level::Warn);
            return;
        };
        self.parsing = true;
        self.parse = None;
        self.send(Cmd::Parse(first));
    }

    // ---------------- UI ----------------

    fn topbar(&mut self, ui: &mut Ui) {
        ui.horizontal(|ui| {
            let (rect, _) = ui.allocate_exact_size(Vec2::splat(34.0), Sense::hover());
            ui.painter().rect_filled(rect, Rounding::same(10.0), ACCENT);
            ui.painter().text(
                rect.center(),
                Align2::CENTER_CENTER,
                "Ac",
                FontId::proportional(15.0),
                Color32::WHITE,
            );
            ui.add_space(4.0);
            ui.vertical(|ui| {
                ui.add_space(1.0);
                ui.label(
                    RichText::new("AcFun 视频下载")
                        .size(15.5)
                        .color(TEXT)
                        .strong(),
                );
                ui.label(
                    RichText::new(format!("桌面版 v{APP_VERSION}"))
                        .size(11.5)
                        .color(FAINT),
                );
            });

            ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                let enabled = self.worker.is_some();
                if widgets::button(ui, "停止服务", Btn::Ghost, enabled).clicked() {
                    self.confirm_exit = true;
                }
                ui.add_space(2.0);
                if widgets::button(
                    ui,
                    if self.show_settings {
                        "收起设置"
                    } else {
                        "设置"
                    },
                    Btn::Secondary,
                    true,
                )
                .clicked()
                {
                    self.show_settings = !self.show_settings;
                }
                ui.add_space(6.0);
                let (color, label) = if self.connected() {
                    (OK, "服务就绪".to_string())
                } else if self.offline.is_some() {
                    (ERR, "连接中断".to_string())
                } else {
                    (WARN, "未连接".to_string())
                };
                ui.label(RichText::new(label).size(12.0).color(MUTED));
                widgets::dot(ui, color, self.connected());
                ui.add_space(6.0);
                ui.label(
                    RichText::new(format!(
                        "成功 {} · 失败 {} · 跳过 {}",
                        self.stats.success, self.stats.failed, self.stats.skipped
                    ))
                    .size(12.0)
                    .color(FAINT),
                );
            });
        });
    }

    fn statusbar(&mut self, ui: &mut Ui) {
        let out_dir = self
            .form
            .as_ref()
            .map(|c| c.out_dir.clone())
            .unwrap_or_default();
        ui.horizontal(|ui| {
            let (color, text) = if self.connected() {
                (
                    OK,
                    format!(
                        "本地服务 127.0.0.1:{}",
                        self.service.as_ref().map(|s| s.port).unwrap_or(0)
                    ),
                )
            } else {
                (ERR, "本地服务未连接".to_string())
            };
            widgets::dot(ui, color, false);
            ui.label(RichText::new(text).size(11.5).color(MUTED));
            ui.add_space(8.0);
            ui.label(RichText::new("·").size(11.5).color(FAINT));
            ui.add_space(8.0);
            let shown = widgets::truncate(&out_dir, ui.available_width() - 200.0, 12.0);
            ui.label(RichText::new(shown).size(11.5).color(FAINT));

            ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                if widgets::button(
                    ui,
                    "在浏览器中打开 WebUI",
                    Btn::Ghost,
                    self.worker.is_some(),
                )
                .clicked()
                {
                    if let Some(s) = &self.service {
                        server::open_browser(&format!(
                            "http://127.0.0.1:{}/?token={}",
                            s.port, s.token
                        ));
                    }
                }
                if widgets::button(ui, "打开目录", Btn::Ghost, !out_dir.is_empty()).clicked() {
                    let path = std::path::PathBuf::from(&out_dir);
                    if path.exists() {
                        server::open_folder(&path);
                    } else {
                        server::open_folder(
                            &std::path::PathBuf::from(&out_dir)
                                .parent()
                                .map(|p| p.to_path_buf())
                                .unwrap_or_default(),
                        );
                    }
                }
                if let Some(s) = &self.service {
                    let hint = if s.spawned {
                        "退出窗口时会停止服务"
                    } else {
                        "复用已有服务"
                    };
                    ui.label(RichText::new(hint).size(11.0).color(FAINT));
                }
            });
        });
    }

    fn input_card(&mut self, ui: &mut Ui) {
        widgets::card(ui, |ui| {
            widgets::section_title(
                ui,
                "粘贴链接",
                Some("支持多行 / 分享文本 / 纯 id；空行与 # 开头的行会被忽略"),
            );
            ui.add_space(8.0);

            Frame::none()
                .fill(FIELD)
                .stroke(Stroke::new(1.0_f32, BORDER))
                .rounding(Rounding::same(10.0))
                .inner_margin(Margin::same(10.0))
                .show(ui, |ui| {
                    ui.add(
                        TextEdit::multiline(&mut self.input)
                            .frame(false)
                            .desired_rows(4)
                            .desired_width(f32::INFINITY)
                            .font(TextStyle::Body)
                            .text_color(TEXT)
                            .hint_text(
                                RichText::new("把播放页 / 社区帖链接粘进来，一行一个\n例如 https://<域名>/play/267427")
                                    .size(13.5)
                                    .color(FAINT),
                            ),
                    );
                });

            ui.add_space(10.0);
            let lines = self
                .input
                .lines()
                .filter(|l| {
                    let t = l.trim();
                    !t.is_empty() && !t.starts_with('#') && !t.starts_with("//")
                })
                .count();
            ui.horizontal(|ui| {
                ui.label(
                    RichText::new(if lines == 0 {
                        "等待输入".to_string()
                    } else {
                        format!("{lines} 行有效输入")
                    })
                    .size(12.0)
                    .color(if lines == 0 { FAINT } else { MUTED }),
                );
                ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                    let can = self.connected() && !self.input.trim().is_empty();
                    let label = if self.submitting {
                        "提交中…"
                    } else {
                        "开始下载"
                    };
                    if widgets::button(ui, label, Btn::Primary, can && !self.submitting).clicked() {
                        self.do_submit();
                    }
                    if widgets::button(
                        ui,
                        if self.parsing {
                            "解析中…"
                        } else {
                            "解析预览"
                        },
                        Btn::Secondary,
                        lines > 0 && !self.parsing,
                    )
                    .clicked()
                    {
                        self.do_parse();
                    }
                    if widgets::button(ui, "清空", Btn::Ghost, !self.input.is_empty()).clicked() {
                        self.input.clear();
                        self.parse = None;
                    }
                    ui.label(RichText::new("Ctrl+Enter 直接提交").size(11.0).color(FAINT));
                });
            });

            if let Some(p) = &self.parse {
                ui.add_space(10.0);
                self.preview_strip(ui, p);
            }
        });
    }

    fn preview_strip(&self, ui: &mut Ui, p: &ParseInfo) {
        let border = if p.ok {
            tint(ACCENT, 110)
        } else {
            tint(ERR, 140)
        };
        Frame::none()
            .fill(CARD_SOFT)
            .stroke(Stroke::new(1.0_f32, border))
            .rounding(Rounding::same(10.0))
            .inner_margin(Margin::symmetric(12.0, 10.0))
            .show(ui, |ui| {
                ui.set_width(ui.available_width());
                if p.ok {
                    ui.horizontal_wrapped(|ui| {
                        let gen_color = match p.generation.as_deref() {
                            Some("vite") => INFO,
                            Some("nuxt") => OK,
                            _ => WARN,
                        };
                        widgets::chip(
                            ui,
                            &p.generation
                                .clone()
                                .unwrap_or_else(|| "未知".into())
                                .to_uppercase(),
                            gen_color,
                            tint(gen_color, 34),
                        );
                        let kind = p.kind.clone().unwrap_or_default();
                        ui.label(
                            RichText::new(format!("类型 {kind}"))
                                .size(12.0)
                                .color(MUTED),
                        );
                        ui.label(
                            RichText::new(format!(
                                "pageId {}",
                                p.page_id.clone().unwrap_or_default()
                            ))
                            .size(12.0)
                            .color(MUTED),
                        );
                        ui.label(
                            RichText::new(p.origin.clone().unwrap_or_default())
                                .size(12.0)
                                .color(FAINT),
                        );
                    });
                    if !p.evidence.is_empty() {
                        ui.add_space(4.0);
                        ui.label(
                            RichText::new(format!("判定依据：{}", p.evidence.join(" · ")))
                                .size(11.5)
                                .color(FAINT),
                        );
                    }
                } else {
                    ui.label(
                        RichText::new(
                            p.error_kind
                                .clone()
                                .unwrap_or_else(|| "PARSE_FAILED".into()),
                        )
                        .size(12.5)
                        .color(ERR)
                        .strong(),
                    );
                    ui.label(
                        RichText::new(p.error_message.clone().unwrap_or_default())
                            .size(12.0)
                            .color(MUTED),
                    );
                    if let Some(s) = &p.error_suggestion {
                        ui.label(RichText::new(format!("建议：{s}")).size(11.5).color(FAINT));
                    }
                }
            });
    }

    fn queue(&mut self, ui: &mut Ui) {
        ui.horizontal(|ui| {
            ui.label(RichText::new("队列").size(14.0).color(TEXT).strong());
            ui.add_space(2.0);
            ui.label(
                RichText::new(format!(
                    "共 {} · 运行 {} · 排队 {}",
                    self.tasks.len(),
                    self.stats.running,
                    self.stats.queued
                ))
                .size(12.0)
                .color(FAINT),
            );
            ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                if self.show_activity {
                    if widgets::button(ui, "收起动态", Btn::Ghost, true).clicked() {
                        self.show_activity = false;
                    }
                } else if widgets::button(ui, "最近动态", Btn::Ghost, !self.activity.is_empty())
                    .clicked()
                {
                    self.show_activity = true;
                }
            });
        });
        ui.add_space(6.0);

        if self.tasks.is_empty() {
            let h = 132.0;
            let (rect, _) =
                ui.allocate_exact_size(Vec2::new(ui.available_width(), h), Sense::hover());
            ui.painter().rect_stroke(
                rect,
                Rounding::same(12.0),
                Stroke::new(1.0_f32, BORDER_SOFT),
            );
            ui.painter().text(
                egui::pos2(rect.center().x, rect.center().y - 10.0),
                Align2::CENTER_CENTER,
                "还没有任务",
                FontId::proportional(13.5),
                MUTED,
            );
            ui.painter().text(
                egui::pos2(rect.center().x, rect.center().y + 12.0),
                Align2::CENTER_CENTER,
                "粘贴链接后点「开始下载」，进度、速度与核验状态都会显示在这里",
                FontId::proportional(12.0),
                FAINT,
            );
            return;
        }

        let tasks = self.tasks.clone();
        let max_h = ui.available_height() - 6.0;
        ScrollArea::vertical()
            .auto_shrink([false, false])
            .max_height(max_h.max(120.0))
            .show(ui, |ui| {
                for t in &tasks {
                    self.task_card(ui, t);
                    ui.add_space(8.0);
                }
                if self.show_activity {
                    ui.add_space(4.0);
                    self.activity_panel(ui);
                }
            });
    }

    fn task_card(&mut self, ui: &mut Ui, t: &TaskView) {
        let (status_label, status_color) = status_style(&t.status);
        Frame::none()
            .fill(CARD)
            .stroke(Stroke::new(1.0_f32, BORDER_SOFT))
            .rounding(Rounding::same(12.0))
            .inner_margin(Margin::same(14.0))
            .show(ui, |ui| {
                ui.set_width(ui.available_width());

                // 第一行：状态点 + 标题 + 百分比 + 操作
                ui.horizontal(|ui| {
                    widgets::dot(ui, status_color, t.active());
                    let percent_text = format!("{:.1}%", t.percent);
                    let actions_w = 150.0;
                    let pct_w = 66.0;
                    // 状态词（下载中/核验中…）也占宽，不减掉会把右侧按钮挤出去
                    let status_w = status_label.chars().count() as f32 * 12.0 + 12.0;
                    let title_w =
                        (ui.available_width() - pct_w - actions_w - status_w - 28.0).max(80.0);
                    let title = widgets::truncate(t.label(), title_w, 14.0);
                    ui.label(RichText::new(title).size(14.0).color(TEXT));
                    ui.label(RichText::new(status_label).size(11.5).color(status_color));
                    ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                        if t.active() && widgets::button(ui, "取消", Btn::Danger, true).clicked()
                        {
                            self.pending_action = Some(Action::Cancel(t.id.clone()));
                        }
                        if matches!(t.status.as_str(), "failed" | "canceled")
                            && widgets::button(ui, "重试", Btn::Secondary, true).clicked()
                        {
                            self.pending_action = Some(Action::Retry(t.id.clone()));
                        }
                        if t.status == "done" {
                            if widgets::button(ui, "定位", Btn::Ghost, true).clicked() {
                                if let Some(p) = &t.output_path {
                                    self.pending_action = Some(Action::Reveal(p.clone()));
                                }
                            }
                            if widgets::button(ui, "打开", Btn::Secondary, true).clicked() {
                                if let Some(p) = &t.output_path {
                                    self.pending_action = Some(Action::Open(p.clone()));
                                }
                            }
                        }
                        ui.add_space(4.0);
                        ui.label(
                            RichText::new(percent_text)
                                .size(16.0)
                                .color(if t.percent >= 100.0 { OK } else { TEXT })
                                .strong(),
                        );
                    });
                });

                ui.add_space(8.0);
                let bar_color = match t.status.as_str() {
                    "done" => OK,
                    "failed" => ERR,
                    "verifying" => WARN,
                    "canceled" | "skipped" => FAINT,
                    _ => ACCENT,
                };
                widgets::progress(
                    ui,
                    (t.percent / 100.0) as f32,
                    bar_color,
                    7.0,
                    t.status == "verifying",
                );

                ui.add_space(6.0);
                let meta = meta_line(t);
                ui.label(RichText::new(meta).size(11.5).color(MUTED));

                if t.status == "failed" {
                    if let Some(msg) = &t.message {
                        ui.add_space(4.0);
                        ui.label(RichText::new(msg).size(11.5).color(ERR));
                    }
                    if let Some(s) = &t.suggestion {
                        ui.label(RichText::new(format!("建议：{s}")).size(11.0).color(FAINT));
                    }
                }
                if t.status == "done" {
                    if let Some(p) = &t.output_path {
                        ui.add_space(4.0);
                        let shown = widgets::truncate(p, ui.available_width(), 11.5);
                        ui.label(RichText::new(shown).size(11.5).color(FAINT));
                    }
                }
            });
    }

    fn activity_panel(&mut self, ui: &mut Ui) {
        Frame::none()
            .fill(CARD_SOFT)
            .stroke(Stroke::new(1.0_f32, BORDER_SOFT))
            .rounding(Rounding::same(10.0))
            .inner_margin(Margin::same(12.0))
            .show(ui, |ui| {
                ui.set_width(ui.available_width());
                ui.label(RichText::new("最近动态").size(12.0).color(MUTED).strong());
                ui.add_space(6.0);
                let items = self
                    .activity
                    .iter()
                    .rev()
                    .take(12)
                    .cloned()
                    .collect::<Vec<_>>();
                for line in items {
                    let color = match line.level {
                        Level::Info => MUTED,
                        Level::Good => OK,
                        Level::Warn => WARN,
                        Level::Bad => ERR,
                    };
                    let t = line.at.elapsed().as_secs();
                    let when = if t < 60 {
                        format!("{t}s")
                    } else {
                        format!("{}m", t / 60)
                    };
                    ui.label(
                        RichText::new(format!(
                            "{when:>4}  {}",
                            widgets::truncate(&line.text, ui.available_width() - 46.0, 11.5)
                        ))
                        .size(11.5)
                        .color(color),
                    );
                }
            });
    }

    fn settings_panel(&mut self, ui: &mut Ui) {
        let Some(form) = self.form.clone() else {
            ui.label(RichText::new("配置还在加载…").size(12.0).color(FAINT));
            return;
        };
        let mut form = form;

        ui.horizontal(|ui| {
            ui.label(RichText::new("设置").size(14.0).color(TEXT).strong());
            ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                if widgets::button(ui, "关闭", Btn::Ghost, true).clicked() {
                    self.show_settings = false;
                }
            });
        });
        ui.add_space(10.0);

        ScrollArea::vertical().auto_shrink([false, false]).show(ui, |ui| {
            // 输出目录
            field_label(ui, "输出目录");
            ui.horizontal(|ui| {
                let w = ui.available_width() - 66.0;
                field(ui, w, |ui| {
                    ui.add(TextEdit::singleline(&mut form.out_dir).frame(false).desired_width(f32::INFINITY));
                });
                if widgets::button(ui, "选择…", Btn::Secondary, true).clicked() {
                    if let Some(dir) = rfd::FileDialog::new().set_title("选择保存位置").pick_folder() {
                        form.out_dir = dir.display().to_string();
                    }
                }
            });

            ui.add_space(10.0);
            field_label(ui, "容器格式");
            ui.horizontal(|ui| {
                for (value, label) in [("mp4", "MP4"), ("mkv", "MKV"), ("ts", "TS")] {
                    let selected = form.container == value;
                    let kind = if selected { Btn::Primary } else { Btn::Secondary };
                    if widgets::button(ui, label, kind, true).clicked() {
                        form.container = value.to_string();
                    }
                }
            });

            ui.add_space(10.0);
            field_label(ui, "重名处理");
            combo(ui, "on_exist", &mut form.on_exist, &[("rename", "自动加序号"), ("skip", "跳过"), ("overwrite", "覆盖")]);

            ui.add_space(10.0);
            field_label(ui, "命名");
            combo(ui, "name_mode", &mut form.name_mode, &[("title", "用视频标题"), ("custom", "固定名 / 模板")]);
            if form.name_mode == "custom" {
                ui.add_space(6.0);
                field(ui, ui.available_width(), |ui| {
                    let mut name = form.name.clone().unwrap_or_default();
                    if ui
                        .add(TextEdit::singleline(&mut name).frame(false).hint_text("固定文件名（留空则用模板）").desired_width(f32::INFINITY))
                        .changed()
                    {
                        form.name = Some(name).filter(|s| !s.is_empty());
                    }
                });
                ui.add_space(6.0);
                field(ui, ui.available_width(), |ui| {
                    let mut tpl = form.template.clone().unwrap_or_default();
                    if ui
                        .add(
                            TextEdit::singleline(&mut tpl)
                                .frame(false)
                                .hint_text("{title} [{author}] {date} {id}")
                                .desired_width(f32::INFINITY),
                        )
                        .changed()
                    {
                        form.template = Some(tpl).filter(|s| !s.is_empty());
                    }
                });
            }

            ui.add_space(12.0);
            ui.horizontal(|ui| {
                number_field(ui, "并发", &mut form.concurrency, 1.0..=8.0);
                ui.add_space(6.0);
                number_field(ui, "重试轮数", &mut form.retries, 0.0..=5.0);
            });
            ui.add_space(8.0);
            ui.horizontal(|ui| {
                number_field(ui, "超时(秒)", &mut form.timeout_sec, 5.0..=300.0);
                ui.add_space(6.0);
                number_field(ui, "间隔(ms)", &mut form.interval_ms, 0.0..=60000.0);
            });

            ui.add_space(10.0);
            field_label(ui, "浏览器通道");
            combo(
                ui,
                "channel",
                &mut form.channel,
                &[("auto", "自动（ego 优先）"), ("ego", "ego lite"), ("chrome", "Chrome + CDP")],
            );

            ui.add_space(12.0);
            field_label(ui, "下载内容");
            widgets::toggle(ui, &mut form.cover, "封面");
            widgets::toggle(ui, &mut form.meta, "元数据 .meta.json");
            widgets::toggle(ui, &mut form.danmaku, "弹幕（实验性）");
            widgets::toggle(ui, &mut form.subtitle, "字幕（实验性）");

            ui.add_space(12.0);
            field_label(ui, "外部工具");
            field(ui, ui.available_width(), |ui| {
                ui.add(TextEdit::singleline(&mut form.ffmpeg_path).frame(false).hint_text("ffmpeg").desired_width(f32::INFINITY));
            });
            ui.add_space(6.0);
            field(ui, ui.available_width(), |ui| {
                ui.add(TextEdit::singleline(&mut form.ffprobe_path).frame(false).hint_text("ffprobe").desired_width(f32::INFINITY));
            });

            ui.add_space(10.0);
            let (ff_color, ff_text) = if !self.env.loaded {
                (FAINT, "探测中…".to_string())
            } else if self.env.ffmpeg.ok {
                (OK, format!("ffmpeg ✓ {}", self.env.ffmpeg.version.clone().unwrap_or_default()))
            } else {
                (ERR, format!("ffmpeg ✗ {}", self.env.ffmpeg.error.clone().unwrap_or_default()))
            };
            let (ego_color, ego_text) = if !self.env.loaded {
                (FAINT, "探测中…".to_string())
            } else if self.env.ego.ok {
                (OK, format!("ego lite ✓ {}", self.env.ego.version.clone().unwrap_or_default()))
            } else {
                (WARN, "ego lite 不可用（将回落到 Chrome）".to_string())
            };
            for (color, text) in [(ff_color, ff_text), (ego_color, ego_text)] {
                ui.label(RichText::new(widgets::truncate(&text, ui.available_width(), 11.5)).size(11.5).color(color));
            }
            if self.env.loaded && !self.env.ffmpeg.ok {
                ui.add_space(6.0);
                ui.label(
                    RichText::new("找不到 ffmpeg/ffprobe：核验与转封装必需，请安装并加入 PATH，或在上方填完整路径。")
                        .size(11.5)
                        .color(WARN),
                );
            }

            ui.add_space(14.0);
            let dirty = self.form.as_ref().map(|orig| !config_eq(orig, &form)).unwrap_or(false);
            if widgets::button(ui, if dirty { "保存设置" } else { "已保存" }, Btn::Primary, dirty).clicked() {
                self.settings_dirty = true;
                self.send(Cmd::SaveConfig(Box::new(form.clone())));
                self.saved_at = Some(Instant::now());
            }
            if let Some(at) = self.saved_at {
                ui.label(RichText::new(format!("最近保存：{} 秒前", at.elapsed().as_secs())).size(11.0).color(FAINT));
            }
            let _ = self.settings_dirty;
        });
    }

    fn confirm_dialog(&mut self, ctx: &egui::Context) {
        if !self.confirm_exit {
            return;
        }
        let mut open = true;
        egui::Window::new("停止本地服务？")
            .open(&mut open)
            .collapsible(false)
            .resizable(false)
            .anchor(Align2::CENTER_CENTER, Vec2::ZERO)
            .frame(Frame::window(&ctx.style()).inner_margin(Margin::same(18.0)))
            .show(ctx, |ui| {
                ui.set_width(320.0);
                ui.label(
                    RichText::new("停止后当前窗口将断开连接，已下载的文件不受影响。")
                        .size(12.5)
                        .color(MUTED),
                );
                ui.add_space(12.0);
                ui.horizontal(|ui| {
                    if widgets::button(ui, "取消", Btn::Secondary, true).clicked() {
                        self.confirm_exit = false;
                    }
                    ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                        if widgets::button(ui, "停止服务", Btn::Primary, true).clicked() {
                            self.send(Cmd::Shutdown(None));
                            self.confirm_exit = false;
                            self.service = None;
                            self.worker = None;
                        }
                    });
                });
            });
        if !open {
            self.confirm_exit = false;
        }
    }

    fn toasts(&mut self, ctx: &egui::Context) {
        self.toasts
            .retain(|t| t.at.elapsed() < Duration::from_secs(4));
        if self.toasts.is_empty() {
            return;
        }
        egui::Area::new(egui::Id::new("toasts"))
            .anchor(Align2::RIGHT_BOTTOM, Vec2::new(-18.0, -58.0))
            .interactable(false)
            .show(ctx, |ui| {
                for toast in self.toasts.iter().rev() {
                    let (color, _) = level_style(toast.level);
                    Frame::none()
                        .fill(CARD)
                        .stroke(Stroke::new(1.0_f32, tint(color, 150)))
                        .rounding(Rounding::same(10.0))
                        .inner_margin(Margin::symmetric(12.0, 8.0))
                        .show(ui, |ui| {
                            ui.label(RichText::new(&toast.text).size(12.0).color(TEXT));
                        });
                    ui.add_space(6.0);
                }
            });
    }

    fn boot_screen(&mut self, ui: &mut Ui) {
        ui.vertical_centered(|ui| {
            ui.add_space(90.0);
            ui.label(
                RichText::new("本地服务没有启动")
                    .size(18.0)
                    .color(TEXT)
                    .strong(),
            );
            ui.add_space(8.0);
            ui.label(
                RichText::new(self.boot_error.clone().unwrap_or_default())
                    .size(12.5)
                    .color(MUTED),
            );
            ui.add_space(16.0);
            ui.horizontal(|ui| {
                ui.add_space((ui.available_width() - 260.0).max(0.0) / 2.0);
                if widgets::button(
                    ui,
                    if self.booting {
                        "正在重试…"
                    } else {
                        "重新启动"
                    },
                    Btn::Primary,
                    !self.booting,
                )
                .clicked()
                {
                    self.retry_boot();
                }
                if widgets::button(ui, "打开日志", Btn::Secondary, true).clicked() {
                    server::open_path_default(&server::log_file());
                }
            });
        });
    }
}

impl eframe::App for App {
    fn update(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        ctx.request_repaint_after(Duration::from_millis(120));
        self.drain();

        if self.worker.is_none() {
            egui::TopBottomPanel::top("topbar")
                .exact_height(58.0)
                .frame(
                    Frame::none()
                        .fill(BG)
                        .inner_margin(Margin::symmetric(18.0, 12.0)),
                )
                .show(ctx, |ui| self.topbar(ui));
            egui::CentralPanel::default()
                .frame(
                    Frame::none()
                        .fill(BG)
                        .inner_margin(Margin::symmetric(18.0, 8.0)),
                )
                .show(ctx, |ui| self.boot_screen(ui));
            return;
        }

        // Ctrl+Enter 提交
        let submit_key = ctx.input(|i| i.modifiers.command && i.key_pressed(egui::Key::Enter));
        if submit_key {
            self.do_submit();
        }
        // 拖入 txt 文件 → 读进输入框
        let dropped: Vec<std::path::PathBuf> = ctx.input(|i| {
            i.raw
                .dropped_files
                .iter()
                .filter_map(|f| f.path.clone())
                .collect()
        });
        for path in dropped {
            if path
                .extension()
                .map(|e| e.eq_ignore_ascii_case("txt"))
                .unwrap_or(false)
            {
                if let Ok(text) = std::fs::read_to_string(&path) {
                    if !self.input.is_empty() && !self.input.ends_with('\n') {
                        self.input.push('\n');
                    }
                    self.input.push_str(&text);
                }
            }
        }

        egui::TopBottomPanel::top("topbar")
            .exact_height(58.0)
            .frame(
                Frame::none()
                    .fill(BG)
                    .inner_margin(Margin::symmetric(18.0, 12.0)),
            )
            .show(ctx, |ui| self.topbar(ui));

        egui::TopBottomPanel::bottom("statusbar")
            .exact_height(42.0)
            .frame(
                Frame::none()
                    .fill(Color32::from_rgb(18, 20, 26))
                    .stroke(Stroke::new(1.0_f32, BORDER_SOFT))
                    .inner_margin(Margin::symmetric(18.0, 8.0)),
            )
            .show(ctx, |ui| self.statusbar(ui));

        if self.show_settings {
            egui::SidePanel::right("settings")
                .exact_width(348.0)
                .resizable(false)
                .frame(
                    Frame::none()
                        .fill(Color32::from_rgb(18, 20, 26))
                        .stroke(Stroke::new(1.0_f32, BORDER_SOFT))
                        .inner_margin(Margin::symmetric(16.0, 14.0)),
                )
                .show(ctx, |ui| self.settings_panel(ui));
        }

        egui::CentralPanel::default()
            .frame(Frame::none().fill(BG).inner_margin(Margin {
                left: 18.0,
                right: 18.0,
                top: 4.0,
                bottom: 10.0,
            }))
            .show(ctx, |ui| {
                self.input_card(ui);
                ui.add_space(12.0);
                self.queue(ui);
            });

        self.confirm_dialog(ctx);
        self.toasts(ctx);

        // 处理任务卡片上的操作（渲染期不能直接发命令，避免借用冲突）
        if let Some(action) = self.pending_action.take() {
            match action {
                Action::Cancel(id) => self.send(Cmd::Cancel(id)),
                Action::Retry(id) => self.send(Cmd::Retry(id)),
                Action::Open(path) => server::open_path_default(&std::path::PathBuf::from(path)),
                Action::Reveal(path) => server::reveal_file(&std::path::PathBuf::from(path)),
            }
        }
    }

    fn clear_color(&self, _visuals: &egui::Visuals) -> [f32; 4] {
        BG.to_normalized_gamma_f32()
    }
}

impl Drop for App {
    fn drop(&mut self) {
        if let Some(s) = &self.service {
            if s.spawned {
                let _ = server::request_shutdown(s.port, &s.token);
            }
        }
    }
}

// ---------------- 小工具 ----------------

fn field(ui: &mut Ui, width: f32, add: impl FnOnce(&mut Ui)) {
    let w = if width <= 0.0 {
        ui.available_width()
    } else {
        width
    };
    ui.allocate_ui_with_layout(
        Vec2::new(w, 30.0),
        Layout::left_to_right(Align::Center),
        |ui| {
            ui.set_width(w);
            Frame::none()
                .fill(FIELD)
                .stroke(Stroke::new(1.0_f32, BORDER))
                .rounding(Rounding::same(8.0))
                .inner_margin(Margin::symmetric(8.0, 5.0))
                .show(ui, |ui| {
                    ui.set_width((w - 18.0).max(20.0));
                    add(ui);
                });
        },
    );
}

fn field_label(ui: &mut Ui, text: &str) {
    ui.label(RichText::new(text).size(11.5).color(FAINT));
    ui.add_space(2.0);
}

fn combo(ui: &mut Ui, id: &str, value: &mut String, options: &[(&str, &str)]) {
    let current = options
        .iter()
        .find(|(v, _)| *v == value.as_str())
        .map(|(_, l)| *l)
        .unwrap_or(value.as_str());
    egui::ComboBox::from_id_salt(id)
        .selected_text(RichText::new(current).size(12.5).color(TEXT))
        .width(ui.available_width())
        .show_ui(ui, |ui| {
            for (v, l) in options {
                ui.selectable_value(value, (*v).to_string(), *l);
            }
        });
}

fn number_field(ui: &mut Ui, label: &str, value: &mut u32, range: std::ops::RangeInclusive<f64>) {
    ui.vertical(|ui| {
        ui.label(RichText::new(label).size(11.0).color(FAINT));
        let mut v = *value as f64;
        if ui
            .add(egui::DragValue::new(&mut v).speed(0.2).range(range))
            .changed()
        {
            *value = v.round() as u32;
        }
    });
}

fn config_eq(a: &Config, b: &Config) -> bool {
    serde_json::to_string(a).ok() == serde_json::to_string(b).ok()
}

fn level_style(level: Level) -> (Color32, &'static str) {
    match level {
        Level::Info => (INFO, "info"),
        Level::Good => (OK, "ok"),
        Level::Warn => (WARN, "warn"),
        Level::Bad => (ERR, "err"),
    }
}

fn status_style(status: &str) -> (&'static str, Color32) {
    match status {
        "queued" => ("排队中", FAINT),
        "resolving" => ("解析中", INFO),
        "manifest" => ("获取清单", INFO),
        "downloading" => ("下载中", ACCENT),
        "verifying" => ("核验中", WARN),
        "done" => ("完成", OK),
        "failed" => ("失败", ERR),
        "skipped" => ("跳过", FAINT),
        "canceled" => ("已取消", FAINT),
        _ => ("未知", MUTED),
    }
}

fn fmt_bytes(n: f64) -> String {
    const UNITS: [&str; 4] = ["B", "KB", "MB", "GB"];
    let mut v = n.max(0.0);
    let mut i = 0usize;
    while v >= 1024.0 && i < UNITS.len() - 1 {
        v /= 1024.0;
        i += 1;
    }
    if i >= 2 {
        format!("{v:.1}{}", UNITS[i])
    } else {
        format!("{v:.0}{}", UNITS[i])
    }
}

fn fmt_mmss(sec: f64) -> String {
    let s = sec.max(0.0) as u64;
    format!("{}:{:02}", s / 60, s % 60)
}

fn meta_line(t: &TaskView) -> String {
    let mut parts: Vec<String> = Vec::new();
    match t.status.as_str() {
        "queued" => parts.push("排队中，等待前面的任务".into()),
        "resolving" => parts.push("解析中（正在浏览器里取清单）…".into()),
        "manifest" => parts.push("拿到清单，准备下载…".into()),
        "verifying" => {
            parts.push("核验中（全片解码 + 帧数/时长比对，可能较慢）".into());
            if let (Some(done), Some(total)) = (t.seg_done, t.seg_total) {
                parts.push(format!("{done}/{total} 段"));
            }
            if let Some(b) = t.bytes {
                parts.push(fmt_bytes(b));
            }
        }
        "done" => {
            if let Some(size) = t.file_size.or(t.bytes) {
                parts.push(format!("已保存 {}", fmt_bytes(size)));
            }
        }
        "canceled" => parts.push("已取消".into()),
        "skipped" => parts.push("已跳过（文件已存在）".into()),
        "failed" => parts.push("失败".into()),
        _ => {
            if let Some(bps) = t.bytes_per_sec {
                if bps > 0.0 {
                    parts.push(format!("{}/s", fmt_bytes(bps)));
                }
            }
            if let (Some(done), Some(total)) = (t.seg_done, t.seg_total) {
                parts.push(format!("{done}/{total} 段"));
            }
            if let Some(b) = t.bytes {
                parts.push(fmt_bytes(b));
            }
            if t.time_sec > 0.0 {
                parts.push(format!("已处理 {}", fmt_mmss(t.time_sec)));
            }
            if let Some(eta) = t.eta_sec {
                if eta > 0.5 {
                    parts.push(format!("剩余约 {}", fmt_mmss(eta)));
                }
            }
            if t.stalled == Some(true) {
                parts.push("等待数据…".into());
            }
        }
    }
    if parts.is_empty() {
        format!("等待开始 · {}", widgets::truncate(&t.url, 300.0, 11.5))
    } else {
        parts.join("  ·  ")
    }
}
