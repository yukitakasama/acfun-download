//! 与本地服务的通信层：REST 客户端 + 后台工作线程。
//!
//! 设计上刻意简单：UI 线程只收发消息，所有阻塞 IO 都在工作线程里，
//! 每 300ms 轮询一次 `/api/tasks`（任务数很少，开销可忽略，也不会像 SSE 那样中途断流）。

use std::sync::mpsc::{channel, Receiver, Sender};
use std::thread;
use std::time::{Duration, Instant};

use serde::Deserialize;
use serde_json::Value;

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct TaskView {
    pub id: String,
    pub url: String,
    pub raw: String,
    pub status: String,
    pub percent: f64,
    pub time_sec: f64,
    pub bytes: Option<f64>,
    pub bytes_per_sec: Option<f64>,
    pub speed_x: Option<f64>,
    pub eta_sec: Option<f64>,
    pub stalled: Option<bool>,
    pub seg_done: Option<u32>,
    pub seg_total: Option<u32>,
    pub attempts: u32,
    pub title: Option<String>,
    pub output_path: Option<String>,
    pub file_size: Option<f64>,
    pub error_kind: Option<String>,
    pub message: Option<String>,
    pub suggestion: Option<String>,
}

impl TaskView {
    pub fn active(&self) -> bool {
        matches!(
            self.status.as_str(),
            "queued" | "resolving" | "manifest" | "downloading" | "verifying"
        )
    }
    pub fn label(&self) -> &str {
        self.title
            .as_deref()
            .or(self.error_kind.as_deref())
            .unwrap_or(&self.url)
    }
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Stats {
    pub total: u32,
    pub success: u32,
    pub failed: u32,
    pub skipped: u32,
    pub running: u32,
    pub queued: u32,
}

#[derive(Clone, Debug, Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    pub out_dir: String,
    pub container: String,
    pub name_mode: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub template: Option<String>,
    pub on_exist: String,
    pub meta: bool,
    pub cover: bool,
    pub danmaku: bool,
    pub subtitle: bool,
    pub concurrency: u32,
    pub retries: u32,
    pub timeout_sec: u32,
    pub interval_ms: u32,
    pub channel: String,
    pub ffmpeg_path: String,
    pub ffprobe_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chrome_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub proxy: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cookie_file: Option<String>,
    pub theme: String,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default)]
pub struct EnvItem {
    pub ok: bool,
    pub version: Option<String>,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Default)]
pub struct EnvState {
    pub ffmpeg: EnvItem,
    pub ego: EnvItem,
    pub loaded: bool,
}

#[derive(Clone, Debug, Default)]
pub struct ParseInfo {
    pub ok: bool,
    pub origin: Option<String>,
    pub kind: Option<String>,
    pub page_id: Option<String>,
    pub generation: Option<String>,
    pub evidence: Vec<String>,
    pub error_kind: Option<String>,
    pub error_message: Option<String>,
    pub error_suggestion: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Level {
    Info,
    Good,
    Warn,
    Bad,
}

/// UI → 工作线程
pub enum Cmd {
    LoadConfig,
    Submit(String),
    Parse(String),
    Cancel(String),
    Retry(String),
    SaveConfig(Box<Config>),
    LoadEnv,
    Shutdown(Option<String>),
}

/// 工作线程 → UI
pub enum Msg {
    Tasks(Vec<TaskView>, Stats),
    Config(Config),
    Env(EnvState),
    Parsed(ParseInfo),
    Submitted {
        created: usize,
        skipped: Vec<String>,
    },
    Note(String, Level),
    Offline(String),
    Online,
}

pub struct Client {
    agent: ureq::Agent,
    base: String,
    token: String,
}

impl Client {
    pub fn new(port: u16, token: String) -> Self {
        let agent = ureq::AgentBuilder::new()
            .timeout_connect(Duration::from_secs(2))
            .timeout(Duration::from_secs(30))
            .build();
        Self {
            agent,
            base: format!("http://127.0.0.1:{port}"),
            token,
        }
    }

    pub fn get(&self, path: &str) -> Result<Value, String> {
        let resp = self
            .agent
            .get(&format!("{}{}", self.base, path))
            .set("x-acfun-token", &self.token)
            .call();
        match resp {
            Ok(r) => {
                let body = r.into_string().map_err(|e| format!("读取响应失败：{e}"))?;
                serde_json::from_str::<Value>(&body).map_err(|e| format!("响应不是 JSON：{e}"))
            }
            Err(ureq::Error::Status(code, r)) => {
                let body = r.into_string().unwrap_or_default();
                Err(pick_error(&body).unwrap_or_else(|| format!("HTTP {code}")))
            }
            Err(e) => Err(format!("连不上本地服务：{e}")),
        }
    }

    fn post(&self, path: &str, body: Option<&str>) -> Result<Value, String> {
        let req = self
            .agent
            .post(&format!("{}{}", self.base, path))
            .set("x-acfun-token", &self.token);
        let resp = match body {
            Some(b) => req.set("content-type", "application/json").send_string(b),
            None => req.send_string(""),
        };
        match resp {
            Ok(r) => Ok(
                serde_json::from_str::<Value>(&r.into_string().unwrap_or_default())
                    .unwrap_or(Value::Null),
            ),
            Err(ureq::Error::Status(code, r)) => {
                let body = r.into_string().unwrap_or_default();
                Err(pick_error(&body).unwrap_or_else(|| format!("HTTP {code}")))
            }
            Err(e) => Err(format!("连不上本地服务：{e}")),
        }
    }

    fn put(&self, path: &str, body: &str) -> Result<Value, String> {
        let resp = self
            .agent
            .put(&format!("{}{}", self.base, path))
            .set("x-acfun-token", &self.token)
            .set("content-type", "application/json")
            .send_string(body);
        match resp {
            Ok(r) => Ok(
                serde_json::from_str::<Value>(&r.into_string().unwrap_or_default())
                    .unwrap_or(Value::Null),
            ),
            Err(ureq::Error::Status(code, r)) => {
                let body = r.into_string().unwrap_or_default();
                Err(pick_error(&body).unwrap_or_else(|| format!("HTTP {code}")))
            }
            Err(e) => Err(format!("连不上本地服务：{e}")),
        }
    }
}

fn pick_error(body: &str) -> Option<String> {
    let v: Value = serde_json::from_str(body).ok()?;
    let err = v.get("error")?;
    let kind = err.get("kind").and_then(Value::as_str).unwrap_or("");
    let msg = err.get("message").and_then(Value::as_str).unwrap_or("");
    let sug = err.get("suggestion").and_then(Value::as_str);
    let base = if kind.is_empty() {
        msg.to_string()
    } else {
        format!("{kind}: {msg}")
    };
    Some(match sug {
        Some(s) if !s.is_empty() => format!("{base}（建议：{s}）"),
        _ => base,
    })
}

pub struct Worker {
    pub tx: Sender<Cmd>,
    pub rx: Receiver<Msg>,
}

/// 起一个工作线程：持有 HTTP 客户端，串行处理命令并周期轮询任务列表。
pub fn spawn(port: u16, token: String) -> Worker {
    let (cmd_tx, cmd_rx) = channel::<Cmd>();
    let (msg_tx, msg_rx) = channel::<Msg>();

    thread::Builder::new()
        .name("acfun-http".into())
        .spawn(move || {
            let client = Client::new(port, token);
            let mut last_poll = Instant::now() - Duration::from_secs(10);
            let mut offline = false;

            loop {
                let timeout = if last_poll.elapsed() >= Duration::from_millis(300) {
                    Duration::ZERO
                } else {
                    Duration::from_millis(300) - last_poll.elapsed()
                };
                let cmd = cmd_rx
                    .recv_timeout(timeout.max(Duration::from_millis(20)))
                    .ok();

                match cmd {
                    None => {}
                    Some(Cmd::Submit(text)) => {
                        let body = serde_json::json!({ "text": text }).to_string();
                        match client.post("/api/tasks", Some(&body)) {
                            Ok(v) => {
                                let created = v
                                    .get("created")
                                    .and_then(Value::as_array)
                                    .map_or(0, Vec::len);
                                let skipped = v
                                    .get("skipped")
                                    .and_then(Value::as_array)
                                    .map(|arr| {
                                        arr.iter()
                                            .filter_map(|s| {
                                                let r = s.get("reason").and_then(Value::as_str)?;
                                                Some(r.to_string())
                                            })
                                            .collect::<Vec<_>>()
                                    })
                                    .unwrap_or_default();
                                let _ = msg_tx.send(Msg::Submitted { created, skipped });
                            }
                            Err(e) => {
                                let _ =
                                    msg_tx.send(Msg::Note(format!("提交失败：{e}"), Level::Bad));
                            }
                        }
                        last_poll = Instant::now() - Duration::from_secs(10);
                        continue;
                    }
                    Some(Cmd::Parse(text)) => {
                        let body = serde_json::json!({ "input": text }).to_string();
                        match client.post("/api/parse", Some(&body)) {
                            Ok(v) => {
                                let _ = msg_tx.send(Msg::Parsed(parse_info(&v)));
                            }
                            Err(e) => {
                                let _ =
                                    msg_tx.send(Msg::Note(format!("解析失败：{e}"), Level::Bad));
                            }
                        }
                        continue;
                    }
                    Some(Cmd::Cancel(id)) => {
                        if let Err(e) = client.post(&format!("/api/tasks/{id}/cancel"), None) {
                            let _ = msg_tx.send(Msg::Note(format!("取消失败：{e}"), Level::Warn));
                        }
                        last_poll = Instant::now() - Duration::from_secs(10);
                        continue;
                    }
                    Some(Cmd::Retry(id)) => {
                        if let Err(e) = client.post(&format!("/api/tasks/{id}/retry"), None) {
                            let _ = msg_tx.send(Msg::Note(format!("重试失败：{e}"), Level::Warn));
                        }
                        last_poll = Instant::now() - Duration::from_secs(10);
                        continue;
                    }
                    Some(Cmd::SaveConfig(cfg)) => {
                        let body = serde_json::to_string(&*cfg).unwrap_or_else(|_| "{}".into());
                        match client.put("/api/config", &body) {
                            Ok(v) => {
                                if let Ok(parsed) = serde_json::from_value::<Config>(
                                    v.get("config").cloned().unwrap_or(Value::Null),
                                ) {
                                    let _ = msg_tx.send(Msg::Config(parsed));
                                }
                                let _ = msg_tx.send(Msg::Note("设置已保存".into(), Level::Good));
                            }
                            Err(e) => {
                                let _ = msg_tx
                                    .send(Msg::Note(format!("保存设置失败：{e}"), Level::Bad));
                            }
                        }
                        continue;
                    }
                    Some(Cmd::LoadConfig) => {
                        match client.get("/api/config") {
                            Ok(v) => {
                                if let Ok(cfg) = serde_json::from_value::<Config>(
                                    v.get("config").cloned().unwrap_or(Value::Null),
                                ) {
                                    let _ = msg_tx.send(Msg::Config(cfg));
                                }
                            }
                            Err(e) => {
                                let _ = msg_tx
                                    .send(Msg::Note(format!("读取配置失败：{e}"), Level::Warn));
                            }
                        }
                        continue;
                    }
                    Some(Cmd::LoadEnv) => {
                        if let Ok(v) = client.get("/api/env") {
                            let env = EnvState {
                                ffmpeg: serde_json::from_value(
                                    v.get("ffmpeg").cloned().unwrap_or(Value::Null),
                                )
                                .unwrap_or_default(),
                                ego: serde_json::from_value(
                                    v.get("ego").cloned().unwrap_or(Value::Null),
                                )
                                .unwrap_or_default(),
                                loaded: true,
                            };
                            let _ = msg_tx.send(Msg::Env(env));
                        }
                        continue;
                    }
                    Some(Cmd::Shutdown(open_dir)) => {
                        let _ = client.post("/api/shutdown", None);
                        if let Some(dir) = open_dir {
                            let _ = msg_tx.send(Msg::Note(
                                format!("已请求停止服务；输出目录：{dir}"),
                                Level::Info,
                            ));
                        }
                        let _ = msg_tx.send(Msg::Note(
                            "本地服务已退出，可以安全关闭窗口".into(),
                            Level::Warn,
                        ));
                        thread::sleep(Duration::from_millis(400));
                        return;
                    }
                }

                if last_poll.elapsed() >= Duration::from_millis(300) {
                    last_poll = Instant::now();
                    match client.get("/api/tasks") {
                        Ok(v) => {
                            let tasks: Vec<TaskView> = serde_json::from_value(
                                v.get("tasks").cloned().unwrap_or(Value::Null),
                            )
                            .unwrap_or_default();
                            let stats: Stats = serde_json::from_value(
                                v.get("stats").cloned().unwrap_or(Value::Null),
                            )
                            .unwrap_or_default();
                            if offline {
                                offline = false;
                                let _ = msg_tx.send(Msg::Online);
                            }
                            let _ = msg_tx.send(Msg::Tasks(tasks, stats));
                        }
                        Err(e) => {
                            if !offline {
                                offline = true;
                                let _ = msg_tx.send(Msg::Offline(e));
                            }
                        }
                    }
                }
            }
        })
        .expect("spawn http worker");

    Worker {
        tx: cmd_tx,
        rx: msg_rx,
    }
}

fn parse_info(v: &Value) -> ParseInfo {
    let generation = v
        .get("generation")
        .and_then(Value::as_str)
        .map(str::to_string);
    ParseInfo {
        ok: v.get("ok").and_then(Value::as_bool).unwrap_or(false),
        origin: v.get("origin").and_then(Value::as_str).map(str::to_string),
        kind: v.get("kind").and_then(Value::as_str).map(str::to_string),
        page_id: v.get("pageId").and_then(Value::as_str).map(str::to_string),
        generation,
        evidence: v
            .get("evidence")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(|x| x.as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default(),
        error_kind: v
            .pointer("/error/kind")
            .and_then(Value::as_str)
            .map(str::to_string),
        error_message: v
            .pointer("/error/message")
            .and_then(Value::as_str)
            .map(str::to_string),
        error_suggestion: v
            .pointer("/error/suggestion")
            .and_then(Value::as_str)
            .map(str::to_string),
    }
}
