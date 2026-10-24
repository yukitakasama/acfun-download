# AcFun 视频下载工具 — 开发计划（PLAN）

> 状态：**待用户确认**。确认后按 §8 里程碑编码，逐段提交。
> 基准依据：本地 skill `acfun-video-download`（`C:\Users\yuki\.config\opencode\skills\acfun-video-download`）的 `SKILL.md` 与 `references/technical-notes.md`。
> 说明：本工具**重新实现**解析/下载/核验逻辑，只把 ego lite 当浏览器通道调用（`spawn ego-browser nodejs`），**不** `node` 执行 skill 自带的 4 个脚本。

---

## 1. 需求确认结论

### 1.1 第一轮（Q1–Q10）

| # | 待确认项 | 结论 |
|---|---|---|
| Q1 | 站点范围 | **马甲域 SPA 为主体做完整实现**（Vite 世代 + Nuxt 3 世代）；`www.acfun.cn/v/ac…`、`/t/ac…` 做**尽力解析**，抓不到就明确报 `OFFICIAL_UNSUPPORTED` 并给建议，不承诺可用 |
| Q2 | 运行形态 | **Web GUI（exe 双击启动）+ CLI 双入口**；dev 阶段前端可在真实浏览器里调试 |
| Q3 | 技术栈 | **TypeScript（Node 24 运行时）+ Rust（Tauri 2 壳）+ Vue 3**；外部程序依赖 `ffmpeg`/`ffprobe`（必需）、`ego-browser`（默认浏览器通道，缺失自动降级 Chrome+CDP） |
| Q4 | 输入形式 | 全支持：纯 URL 多参数、分享文本自动提取（含短链 302 跟随）、`-f urls.txt` 按行读取（忽略空行 / `#` / `//` 注释）、stdin 管道 |
| Q5 | 登录鉴权 | 默认用 ego lite 用户真实 profile（天然带登录态）；`--cookie <file>` 与 `ACFUN_COOKIE` 仅用于 Chrome 兜底通道；未登录时公开内容照下，需登录/购买一律**停止**（`canWatch=false` / 清单非 `#EXTM3U` / 抓不到 `authPath`），不绕过 |
| Q6 | 清晰度与格式 | 多码率取 bandwidth 最高；`ffmpeg -c copy` 转封装 MP4（不重编码）；`--container mp4\|mkv\|ts` |
| Q7 | 附加资源 | 元数据 sidecar JSON（默认开）、封面（默认开）、弹幕（默认关，标注实验性）、字幕（默认关） |
| Q8 | 命名 | `--name-mode title`（默认）或 `custom` + `--name`/`--template`；占位符 `{title}{author}{date}{id}{index}`；非法字符与控制字符→`_`；含扩展名总长 ≤ 200；重名默认 `rename`（`-1`/`-2`） |
| Q9 | 批量策略 | 并发默认 1（可调）；整片重取清单重试 2 轮 + 网络错误 1s→2s→4s 退避；每条独立成败；Ctrl+C 保留 `.part` 并 exit 130；**简版续传**（见 §6.3）；失败清单 `reports/failures-<ts>.json` |
| Q10 | 目录与限速 | 默认 `<cwd>/downloads/` 平铺 + `<out-dir>/reports/`；任务间隔 1.5s、真实 Chrome UA、自动 Referer、`--timeout` 30s、`--proxy` 可选（默认关） |

### 1.2 第二轮（Q11–Q16）

| # | 结论 |
|---|---|
| Q11 | **直接上 Tauri 2（Rust 壳）**。本机缺 rustup + MSVC Build Tools，须先安装（见 §2 前置条件）；在此之前所有里程碑走「TS core + CLI + 本地服务 + 浏览器调试」，功能不被阻塞 |
| Q12 | GUI 含：输入区+解析预览、任务队列+实时进度、设置页（持久化）、日志+失败清单+历史 |
| Q13 | exe **内嵌 Node runtime（sidecar），不内嵌 ffmpeg**：启动时探测 PATH，读不到就在设置页黄色告警并引导填写路径 |
| Q14 | **仅 Windows x64**（README 明确不保证 macOS/Linux） |
| Q15 | **保留 CLI + GUI 双入口**，两者共用同一 core 包 |
| Q16 | 进度推送用 **SSE**（同时供浏览器调试与 Tauri WebView 消费） |

---

## 2. 环境前置与现状（本机实测）

| 项 | 状态 | 备注 |
|---|---|---|
| Node | ✅ v24.15.0 | 原生 fetch / WebSocket / node:test / TS 直跑需构建 |
| npm / pnpm / bun | ✅ 11.12.1 / 12.14.0 / 1.3.14 | 用 **pnpm workspace** |
| TypeScript | ✅ 7.0.2（全局） | 项目内锁 devDependency |
| ffmpeg / ffprobe | ✅ 在 PATH | 核验与转封装必需 |
| ego-browser | ✅ 0.6.0.22 运行中（chromium 154） | 默认浏览器通道 |
| WebView2 Runtime | ✅ 155.0.4283.62 | Tauri 2 依赖，已满足 |
| Rust（rustc/cargo） | ❌ 未安装 | **M7 前必须装** |
| MSVC Build Tools | ❌ 未安装（仅 Git 自带 link.exe，非 MSVC 链接器） | **M7 前必须装**（VS Build Tools + Windows SDK） |
| git | ✅ 2.54.0 | 仓库已初始化 |

> M7 开工前我会先跑 `rustc --version && cargo --version` 与 `cargo check` 自检；若环境仍未就绪，M7 挂起并照常交付 M0–M6（CLI + 本地服务 + 浏览器可用版），不会阻塞其它里程碑。

---

## 3. 技术方案与模块划分

### 3.1 架构总览

```
┌────────────────────────────┐        ┌───────────────────────────────┐
│  Tauri 2 壳 (Rust)         │        │  Vue 3 SPA (Vite)             │
│  · 单实例/窗口/托盘         │        │  · 输入区/队列/进度/设置/日志  │
│  · 拉起并守护 node sidecar │◀─IPC──▶│  · fetch + EventSource(SSE)   │
│  · 退出清理/日志落盘        │        └──────────────┬────────────────┘
└──────────┬─────────────────┘                       │ HTTP + SSE
           │ spawn (stdio 守护)                      │ 127.0.0.1:<随机端口>
           ▼                                        ▼
┌──────────────────────────────────────────────────────────────────────┐
│  apps/server（Node 24，内嵌于 exe 的 sidecar）                        │
│  · Hono REST + SSE  · 端口随机绑定 + 一次性 token 鉴权                 │
│  · 任务队列/取消/重试  · 配置持久化                                    │
└──────────┬───────────────────────────────────────────────────────────┘
           │ import（同一进程）
           ▼
┌──────────────────────────────────────────────────────────────────────┐
│  packages/core（纯 TS，无 UI/无进程副作用，全部可单测）                │
│  input → site → manifest → download → verify → naming → report        │
└──────────────────────────────────────────────────────────────────────┘
           │ spawn
           ├──▶ ego-browser nodejs（默认）/ Chrome+CDP（兜底）
           └──▶ ffmpeg / ffprobe
```

**双入口**：`apps/cli`（`acfun` 命令）与 `apps/server` 都只是 core 的使用者；GUI 不含任何业务逻辑。

### 3.2 目录结构（交付物形态）

```
ACFUN-download/
├─ .gitignore
├─ README.md
├─ package.json                 # pnpm workspace 根
├─ pnpm-workspace.yaml
├─ tsconfig.base.json
├─ packages/
│  └─ core/                     # ★ 全部业务逻辑 + 单测
│     ├─ src/input/             # 输入归一：URL 提取、短链、文件/stdin
│     ├─ src/site/              # 站点与世代判定、ID 归一
│     ├─ src/browser/           # ego lite 通道 + Chrome/CDP 兜底
│     ├─ src/manifest/          # 清单抓取与解析、多码率选择、过期判断
│     ├─ src/download/          # ffmpeg 转封装、进度、核验、重试
│     ├─ src/naming/            # 清洗、模板、重名
│     ├─ src/assets/            # 封面/弹幕/字幕/meta sidecar
│     ├─ src/report/            # 汇总 JSON/CSV、失败清单
│     ├─ src/errors.ts          # 错误分类 + 可读文案 + 建议
│     └─ test/                  # vitest 单测 + fixture
├─ apps/
│  ├─ cli/                      # acfun 命令行入口
│  └─ server/                   # 本地服务（REST + SSE）+ sidecar 入口
├─ apps/web/                    # Vue 3 + Vite 前端
├─ apps/desktop/                # Tauri 2（src-tauri/）+ 打包配置
├─ docs/
│  ├─ PLAN.md                   # 本文件
│  └─ SELFTEST.md               # 自测记录（3 条真实用例）
└─ downloads/                   # 默认输出（git 忽略）
```

### 3.3 依赖取舍

- 运行期：`hono`（服务）、`zod`（配置与 IPC 校验）。**不引入** axios/undici（用原生 fetch）、不引入 cheerio（站点是 SPA，HTML 只做特征 grep）。
- 开发期：`typescript`、`vitest`、`vue`、`vite`、`@vitejs/plugin-vue`、`tsup`（core/server 打包）、`@tauri-apps/cli`、`@tauri-apps/api`。
- 外部程序：`ffmpeg`/`ffprobe`（必需，不内嵌）、`ego-browser`（默认通道）、Chrome（兜底通道）。

---

## 4. 解析思路（依据：skill 实测结论）

### 4.1 输入归一（`src/input`）

1. 分享文本 → 正则 `https?://[^\s"'<>，。；！）】]+` 提取，去掉尾部中英文标点；短链（非目标域名）最多跟随 3 次 302（`redirect: 'manual'`，仅取 `location`）。
2. `-f urls.txt`：按行读，`trim` 后跳过空行、`#` 开头、`//` 开头；行内再走一次分享文本提取。
3. stdin（`-`）：同上。
4. 去重（同一 `origin+path` 只保留首次出现），并保留原始行以便报告定位。

### 4.2 站点与世代判定（`src/site`）

依据 skill「两代前端判定」表，**不用先开浏览器**（站点 HTML 可裸 curl）：

```
GET <页面URL>  (UA=真实 Chrome)
grep -oE '/_nuxt/|/assets/index-|https://acpcssr\.[a-z0-9]+\.work'
```

- 命中 `/_nuxt/` 或 `acpcssr.*.work` → **Nuxt 3 世代**（免鉴权 `public/decode/authPath`，无 `aut`、无加密）。
- 命中 `/assets/index-` → **Vite 世代**（`aut` JWT + `t`/`s` 签名 + AES-CBC 加密响应 + `canWatch`）。
- URL 形态：`/play/<id>`、`/videos/play/<id>`、`/splay/<id>`、`/community/<id>` 判为可下载；`/community/<id>` 的 **帖子 id ≠ 视频 id**，禁止用 URL id 拼视频接口。
- `www.acfun.cn/v/ac<id>`、`/t/ac<id>` → 标记 `official`，走 §4.5 尽力解析。
- 判定失败（HTML 取不到/特征全无）→ `SITE_UNKNOWN`，带建议：检查域名是否马甲域、是否需要代理、是否被 WAF 拦。

### 4.3 清单获取（`src/browser` + `src/manifest`）

**Nuxt 3 世代**（主路径）：
1. `taskSpace(唯一名)` → `page`；**`page.cdp('Network.enable')` 必须早于 `page.goto`**。
2. 每条任务 `goto` 前先 `await page.events()` **丢弃残留缓冲**（skill 实测坑：`page.events()` 取走即清空，跨条目会串页，导致不存在的 id 也"成功"）。
3. 轮询 `page.events()` 匹配 `m3u8/(public/)?decode/authPath`，命中即取其 URL（页面自签名，天然最新）。
4. `page.fetch(authUrl)` 在页面上下文重放（自动带 Referer/Cookie）→ 必须含 `#EXTM3U`，否则按安全边界停止。
5. 解析 `#EXTINF` 累加得 `manifestDurationSec`；`#EXT-X-STREAM-INF` 存在时选最高 bandwidth 子清单；记录 `#EXT-X-ENDLIST` 缺失告警。
6. `task.finish({ keep: [] })` 收尾，不在用户窗口留残页。

**Vite 世代**：
1. 从网络事件抓任一 `/api/` 请求头，取 `aut`/`sid`/`deviceId`/`device`/`appVersion`（**大小写不敏感**，HTTP/2 会小写）。
2. `page.fetch('/api/video/getVideoById?videoId=<id>&_t=<t>')`，带签名头 `t=Date.now()`、`s=md5(t.slice(3,8))`、`User-Mark: xhp` 等。
3. 解密：AES-128-CBC，`key = iv = Buffer.from(aut.slice(2,18))`，Pkcs7 → `encData` 明文 JSON。
4. **检查 `canWatch === true`**，否则 `AUTH_REQUIRED` 停止。
5. `page.fetch('/api/m3u8/decode/authPath?path=<videoUrl>&auth_key=<authKey>&id=<cdnList[0].id>')`。

**chrome 兜底通道**：同一链路，浏览器由 `--remote-debugging-port=<空闲端口>` + 独立 `--user-data-dir` 启动（`Start-Process` 分离启动，避免被进程树清理），取页面用 CDP `Network.requestWillBeSent`。`ego-browser --version`（结果在 **stderr**）无输出时才启用。

### 4.4 官方站尽力解析（`official`）

不开新流程，只做一次低成本尝试：页面内 `fetch` 站点自带播放信息接口/内联 `window.__INITIAL_STATE__`，能取到 HLS/DASH 清单就直接进入 §4.3 第 5 步；取不到 → `OFFICIAL_UNSUPPORTED`，文案明确「官方站需另做逆向适配，本次未实现」，**不产出空文件、不静默失败**。该分支在 README 标注为实验性。

### 4.5 安全边界（硬编码，不可配置关闭）

- 只下载站点允许公开播放的内容：`canWatch === true`（Vite）或 `authPath` 为 `public` 且正常返回 `#EXTM3U`（Nuxt）。
- 只拿到 `previewUrl` → 说明是预览，停止并告知。
- 需登录/购买 → 停止，不做任何绕过。
- **解码核验不可关闭**（不提供 `--no-verify`）：skill 实测 ffmpeg 丢片照样 exit 0。

---

## 5. CLI 参数表

```
acfun <command> [inputs...] [options]

命令
  dl       <input...>        下载（支持 URL / 分享文本 / 多个）
  parse    <input...>        只解析，输出 JSON（不下载）——自测与调试用
  batch    -f <file>         批量（等价 dl -f，语义更明确）

输入
  -f, --file <path>          文本清单（按行，忽略空行/#///）
  -                       stdin

输出与命名
  -o, --out-dir <dir>        默认 ./downloads
      --name-mode title|custom        默认 title
      --name <fixed-name>              custom 模式固定名
      --template <tpl>                 custom 模式模板，如 "{title} [{author}] {date} {id}"
      --on-exist rename|skip|overwrite  默认 rename
      --container mp4|mkv|ts           默认 mp4（-c copy）

扩展资源
      --meta / --no-meta      sidecar .meta.json（默认开）
      --cover / --no-cover    封面（默认开）
      --danmaku               弹幕（默认关，实验性）
      --subtitle              字幕（默认关，站点有时才下）

网络与限速
      --concurrency <n>       默认 1（>1 时仅并行 ffmpeg 阶段，浏览器取清单恒串行）
      --retries <n>           默认 2 轮（整片重取清单）
      --timeout <sec>         默认 30
      --interval <ms>         任务间隔，默认 1500
      --proxy <url>           默认关（ego 通道不支持时告警并回落 Chrome/ffmpeg）
      --cookie <file>         仅 Chrome 兜底通道；亦可用 ACFUN_COOKIE
      --resume                复用未过期清单恢复未完成任务

外观与机器可读
      --report json|csv       默认 json（同时写 failures-<ts>.json）
      --json                  进度与结果以 NDJSON 输出到 stdout
  -v, --verbose
      --help / --version

退出码
  0 全部成功 | 1 参数/环境错误 | 3 部分或全部失败 | 130 用户中断（Ctrl+C，保留 .part）
```

---

## 6. 数据结构与策略

### 6.1 核心类型

```ts
type Generation = 'vite' | 'nuxt' | 'official' | 'unknown';
type TaskStatus = 'queued' | 'resolving' | 'manifest' | 'downloading' | 'verifying' | 'done' | 'failed' | 'skipped' | 'canceled';

interface InputItem   { raw: string; url: string; line?: number; source: 'arg'|'file'|'stdin'|'text' }
interface ParsedTarget{ url: string; origin: string; kind: 'video'|'post'|'article'; pageId: string; generation: Generation }
interface VideoMeta   { videoId: string; title: string; author: string; authorId?: string; publishTime?: string;
                        durationSec?: number; coverUrl?: string; pageUrl: string; generation: Generation }
interface Manifest    { playlistUrl: string; text: string; segments: number; durationSec: number;
                        variantBandwidth?: number; hasEndlist: boolean; keyExpireAt?: number }
interface Task        { id: string; item: InputItem; status: TaskStatus; attempts: number;
                        progress: { percent: number; timeSec: number; bytes?: number; segDone?: number; segTotal: number };
                        meta?: VideoMeta; outputPath?: string; error?: AppError; startedAt?: number; finishedAt?: number }
interface TaskResult  { taskId: string; status: 'success'|'failed'|'skipped'; filePath?: string; fileSize?: number;
                        verified?: { frames: number; durationSec: number; manifestDurationSec: number };
                        errorKind?: string; message?: string; suggestion?: string }
```

### 6.2 异常分类与处理（`src/errors.ts`，每条都带 `suggestion`）

| kind | 触发 | 处理 | 建议文案要点 |
|---|---|---|---|
| `NET_TIMEOUT` | fetch/goto 超时 | 退避重试（1s/2s/4s） | 检查网络/代理；马甲域偶发 RST 重跑即可 |
| `EDGE_RESET` | `ERR_CONNECTION_RESET` | 计入两轮整片重试 | 边缘节点随机重置，重跑一轮 |
| `HTTP_403` / `HTTP_404` | 清单/分片返回 | 重取清单一轮；仍失败则失败 | 签名可能过期（分钟级）；或内容已下架 |
| `AUTH_REQUIRED` | `canWatch=false`、抓不到 `authPath` | **不重试**，立即失败 | 该内容需登录/购买，本工具不绕过 |
| `MANIFEST_NOT_HLS` | 返回非 `#EXTM3U` | 失败 | 内容不可公开播放 |
| `PAGE_ERROR_TITLE` | 标题命中 `bad gateway/404/502/错误/找不到…` | 交付前拦截 | 站点对无效 id 回退播放别的内容 |
| `PARSE_FAILED` / `SITE_UNKNOWN` | 世代无法判定 | 失败 | 检查域名形态、是否需代理 |
| `OFFICIAL_UNSUPPORTED` | acfun.cn 官方站取不到流 | 失败 | 官方站未适配，属已知限制 |
| `FFMPEG_MISSING` | PATH 找不到 | 启动即失败（前置检查） | 安装 ffmpeg 或设置配置项 |
| `FFMPEG_FAILED` | 进程非 0 | 整片重试一轮 | 分片签名过期需重取清单 |
| `VERIFY_FAILED` | `-f null` 有输出 / 时长帧数不符 | 整片重试一轮，两轮均脏→删残件 | 疑似丢分片 |
| `USER_ABORT` | Ctrl+C | 保留 `.part` + 清单，exit 130 | 用 `--resume` 继续 |

### 6.3 下载、进度与续传

- 命令：`ffmpeg -hide_banner -y -protocol_whitelist file,http,https,tcp,tls,crypto -allowed_extensions ALL -i <manifest.m3u8> -c copy -progress pipe:1 -nostats <out>.part.mp4`
- 进度：解析 `-progress pipe:1` 的 `out_time_us`，`percent = out_time / manifestDurationSec`；SSE 每 ≤500ms 推送一次（合并抖动）。
- **核验（不可跳过）**：`ffmpeg -v error -i part -f null -` 必须无输出；`ffprobe -count_frames` 得 `nb_read_frames` 与 `duration`，要求 `|duration - manifestDuration| ≤ max(1.5s, 2%)` 且 `frames ≥ 0.985 × duration × fps`。通过才 `rename` 为交付名。
- **简版续传**（Q9 结论）：中断时落 `resume.json`（目标路径、清单 URL、`auth_key` 过期时间、attempt）。`--resume` 时：
  1. 清单签名仍有效 → 对已存在 `.part.mp4` 先做一次核验：通过则直接转正；不通过则覆盖重下。
  2. 签名已过期 → 重取清单整片重下，旧 `.part.mp4` 改名为 `.part.stale-<ts>` 保留（不覆盖、不删除用户数据）。
- 已完成成品**永不覆盖**（`--on-exist overwrite` 显式指定才覆盖）。

### 6.4 命名与输出

- 清洗顺序：模板渲染 → 非法字符 `\ / : * ? " < > |` 与 `[\x00-\x1f\x7f]` → `_` → 连续空白压成单空格 → 去首尾空格与结尾 `.`/空格（Windows 限制）→ 截断到 `200 - ext.length` → 空则回退 `acfun-<id>` → 避开 Windows 保留名（`CON/PRN/AUX/NUL/COM1-9/LPT1-9`，命中则前缀 `_`）。
- 批量 `{index}`：三位补零 `001` 起，按输入顺序（不是完成顺序）。
- 输出：`downloads/<名称>.<ext>`、`downloads/<名称>.meta.json`、`downloads/<名称>.jpg`（封面）；汇总 `downloads/reports/<ts>-result.json|csv`、`downloads/reports/failures-<ts>.json`。

### 6.5 并发模型（重要修正）

ego lite 是**单一 GUI 实例 + 用户真实 profile**，任务空间并行会互抢且更易触发风控。因此：

- **浏览器阶段（取清单）恒串行**（即使 `--concurrency > 1`）。
- `--concurrency > 1` 只并行 **ffmpeg 下载/核验阶段**（每任务独立 `.part` 与清单文件，互不干扰）。
- 该语义会写进 `--help` 与 README，避免用户误解。

### 6.6 本地服务与 GUI 通信

- 服务只绑 `127.0.0.1`，端口 `0`（系统分配），启动后把端口+一次性 token 通过 stdout 首行 JSON 交给 Rust 壳；Rust 用它注入 WebView 或交给前端。
- REST：`POST /api/tasks`（提交输入）、`GET /api/tasks`、`POST /api/tasks/:id/cancel|retry`、`GET /api/config`、`PUT /api/config`、`GET /api/history`、`GET /api/failures`。
- SSE：`GET /api/events`（`task`/`progress`/`log`/`done` 四类事件）。
- 配置持久化：`%APPDATA%\acfun-download\config.json`（忽略进 git）；CLI 用 `--config` 或同路径只读。

---

## 7. 测试计划

### 7.1 单元测试（vitest，`packages/core/test`，任务书硬性要求全覆盖）

- **URL 解析**：`/play/`、`/videos/play/`、`/splay/`、`/community/`、`www.acfun.cn/v/ac123`、`/t/ac456`、带 query、分享文本（含中文与表情/全角标点）、短链 mock 302、非法串、重复输入去重。
- **文件名清洗**：`\ / : * ? " < > |`、控制字符、全非法、emoji、超长（含扩展名恰 200/201）、结尾点与空格、Windows 保留名、空标题回退。
- **模板渲染**：全部 5 个占位符、缺字段回退（`{author}` 缺失时不留空括号）、`{index}` 补零、未知占位符保留原文、`{date}` 格式与非法日期。
- 附加：世代判定（HTML fixture）、`auth_key` 过期判断、重名策略、错误分类映射、CSV/JSON 报告结构。

### 7.2 集成测试（不联网，mock ego/ffmpeg 进程）

- 事件缓冲串页防护：构造"上一条剩余事件 + 下一条无 `authPath`"，断言第二条判失败（回归 skill 实测坑）。
- 批量部分失败不被吞：`exit code = 3`，`failures-*.json` 含失败条目。
- 两轮重试与退避时序（fake timers）。
- Ctrl+C：收到 SIGINT 后保留 `.part` 并 exit 130。

### 7.3 真实自测（`docs/SELFTEST.md`，至少 3 条，记录命令与真实输出）

1. **单视频**：马甲域 `/play/<id>`（Vite 世代，验证 `aut` 抓取 + 解密 + `canWatch`）。
2. **帖子页**：`/community/<id>`（Nuxt 世代，验证自动起播 + `public/authPath` + 帖子 id≠视频 id）。
3. **批量**：`batch -f urls.txt`，含 1 条故意不存在的 id，验证「独立成败、不串页、exit 3、失败清单」。
每条记录：命令、耗时、产物大小、`nb_read_frames`/时长与清单对齐数值、最终路径与状态。

---

## 8. 里程碑与验收标准

| 里程碑 | 内容 | 验收标准 | tag |
|---|---|---|---|
| **M0 骨架** | pnpm workspace、tsconfig、vitest、eslint 取舍、`.gitignore`、README 骨架 | `pnpm -r build` 通过；空实现单测可跑 | `v0.0-skeleton` |
| **M1 解析层** | 输入归一（URL/分享文本/文件/stdin/短链）、站点与世代判定、ID 归一 + 单测 | 单测全绿；`acfun parse <url>` 打印含 `origin/kind/pageId/generation` 的 JSON | `v0.1-parse` |
| **M2 命名层** | 清洗/模板/重名/序号 + 单测 | 清洗与模板两组单测全绿（含 200 字符与保留名边界） | `v0.2-naming` |
| **M3 取清单** | ego lite 通道 + Chrome/CDP 兜底 + 两代链路 + 安全边界 + 串页防护 | `acfun parse` 能打印 `segments/durationSec/bandwidth`；需鉴权内容返回 `AUTH_REQUIRED` 且不产出文件 | `v0.3-manifest` |
| **M4 下载核验** | ffmpeg 转封装、`-progress` 进度、全量解码核验、两轮整片重试、`.part` | 真实单条下载成功且核验通过；人为损坏 `.part` 时核验拒绝交付 | `v0.4-download` |
| **M5 批量与报告** | 队列、并发语义、限速、退避、`--resume`、结果汇总/失败清单、退出码 | 3 条批量用例：成功/失败/跳过均正确归类，exit 3，`failures-*.json` 完整 | `v0.5-batch` |
| **M6 服务与 GUI** | Hono REST + SSE、Vue 3 界面（4 大区块）、配置持久化 | 浏览器打开可完成"粘贴→解析预览→下载→看进度→看日志/失败清单"全流程 | `v0.6-gui` |
| **M7 桌面壳** | Tauri 2 窗壳、Node sidecar 内嵌、单实例、托盘、随机端口+token、退出清理 | 双击 exe 起 GUI；关闭后无残留 node 进程；`rustc/cargo` 环境自检通过 | `v0.7-desktop` |
| **M8 交付** | README（安装/用法/参数/FAQ/commit+tag 索引）、SELFTEST.md、单测报告 | 3 条真实自测记录齐全；README 可按图索骥跑通 | `v1.0` |

### 验收口径（全局）

1. 任何失败都有 `errorKind + message + suggestion`，**禁止静默失败与空文件**（产物大小 0 视为失败）。
2. 每条任务结束必须打印最终路径与状态，并落汇总文件。
3. 核验不可关闭；核验不通过不得交付。
4. 主干（`main`）任一 commit 均可运行/可通过单测；试错改动走 `exp/*` 分支。

---

## 9. Git 规范

- `.gitignore` 先于首次提交：忽略 `downloads/`、`node_modules/`、`dist/`、`src-tauri/target/`、`*.part.mp4`、`*.m3u8` 缓存、`*.log`、`cookies*.txt`、`.env*`、`config.local.json`、`.venv/`、`__pycache__/`、`.vite/`。
- 约定式提交，**每个可运行功能点单独提交**：`feat(cli): ...`、`fix(manifest): ...`、`docs: ...`、`test: ...`、`chore: ...`。
- 每个里程碑打 tag（见 §8）；README 末尾维护「关键 commit 与 tag」表，便于回退定位。
- 试错性改动（如并发策略、续传实现）放 `exp/*` 分支，验证后 rebase/合并，主干保持可运行。

---

## 10. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| 本机无 Rust/MSVC（M7 前置） | 打包受阻 | M0–M6 不依赖 Rust；M7 前先装 rustup + VS Build Tools 并 `cargo check` 自检；关键路径是 TS 侧，Rust 仅壳层 |
| 马甲域随机更换 + 边缘节点 RST | 偶发失败 | 两轮整片重试 + 退避；origin 一律从输入推导，**不硬编码域名** |
| 分片签名分钟级过期 | 重试窗口短 | 取到清单立即下载；过期即重取清单，不做长时间排队 |
| ego lite 单实例共享用户 profile | 并发受限 | 浏览器阶段串行；并发仅作用于 ffmpeg 阶段 |
| 弹幕/字幕接口无实测依据 | 功能可能不可用 | 默认关闭，README 标注实验性，失败只告警不阻塞主流程 |
| Tauri sidecar 体积（内嵌 Node） | exe ~100MB+ | 已确认接受；构建脚本单独说明产物大小 |
| 官方站无 skill 依据 | 可能整段不可用 | 明确 `OFFICIAL_UNSUPPORTED` 语义，README 标注实验性，不阻塞主线 |

---

## 11. 待你确认的开放点（确认后开工）

1. 本 PLAN 是否可按 §8 里程碑执行（M0→M8，逐段提交、每段打 tag）。
2. `--concurrency > 1` 仅并行 ffmpeg 阶段、浏览器恒串行——这一语义是否接受（§6.5）。
3. 是否现在就需要我准备 Rust + MSVC 安装指引（M7 才用到，但可提前并行装）。
4. 单测框架选 **vitest**（而非 node:test），因需 Vue 组件测试与 fake timers——是否同意。

> 确认（或提出修改）后，我将：① 建 M0 骨架 → ② 按里程碑逐段编码并提交 → ③ 跑 3 条真实自测并写 `docs/SELFTEST.md`。

---

## 12. 实施变更记录（开发中追加）

- **2026-10-24 · M7 取消（需求变更）**：GUI 是 Web GUI，要在浏览器里运行，**不打包原生 UI**。
  原先的 Tauri 2 原生壳（含内嵌 Node sidecar 的原生窗口方案）已移除；改为**浏览器版绿色包**：
  `node.exe` + 自包含 `server/index.js` + `web/**` + `启动.cmd`（双击起本地服务并用默认浏览器打开 GUI）。
  打包脚本：`scripts/package-web.mjs`（`pnpm package:web`），产物在 `dist/`。
  前端验证统一用 **ego lite 的独立 task space** 做（与下载通道同一个浏览器，便于对照）。
- 顺带修正 §2 的环境判断：本机 **MSVC C++ 工具（14.44）与 Windows SDK 10.0.26100 其实已安装**，
  Rust（rustup stable-x86_64-pc-windows-msvc）也已就绪；之前判为缺失是因为不在 Git Bash 的 PATH 里。

- **2026-10-24 · 交付形态再调整：出 NSIS 安装程序**。安装后桌面/开始菜单有带图标的「AcFun 下载」，
  点它**只**起本地服务并用默认浏览器打开界面（仍然不打包原生 UI）。
  实现：`packaging/launcher`（Rust，纯 std 的启动器：读 `%APPDATA%cfun-download\server.json` 复用已运行实例、
  否则 `CREATE_NO_WINDOW` 拉起 `node.exe + server/index.js --state-file …`，再 `start` 浏览器）
  + `packaging/installer.nsi`（按用户安装到 `%LOCALAPPDATA%\Programs\AcFun下载`，快捷方式/卸载/保留用户数据）
  + 服务端新增 `--state-file` 与 `POST /api/shutdown`（界面右上角「退出服务」）。
  打包脚本：`pnpm package:installer`。

---

## 需求变更记录：界面改为原生桌面 GUI（v1.4）

**背景**：`v1.1`–`v1.3` 采用「本地服务 + 浏览器 GUI」。实际试用后认为 WebUI 的视觉与操作手感不理想，
要求改成原生桌面应用，同时**不得移除 WebUI 的测试能力**。

**方案取舍**：

| 方案 | 结论 |
|---|---|
| Tauri 2 / WebView 再包一层 | ❌ 仍是网页渲染，视觉问题解决不了，还得额外处理 WebView2 运行时 |
| 整个下载引擎重写成 Rust | ❌ 风险与工期都不可接受，且会丢掉已通过 157 条测试的 TS 实现 |
| **Rust + egui 原生窗口，HTTP 驱动现有本地服务** | ✅ 采纳 |

**落地结构**：

```
AcFunDownload.exe (Rust/eframe+egui)  ── HTTP ──▶  node.exe server/index.js  ──▶  core(TS)
        │                                              │
        └── 负责窗口/交互/服务生命周期                  └── 同时伺服 web/ 给 WebUI 调试
```

- GUI 只做「客户端 + 服务管理器」：读 `%APPDATA%cfun-download\server.json` 复用已有实例，
  否则用同目录 `node.exe` 拉起（`CREATE_NO_WINDOW`），关窗时若由自己拉起则 `POST /api/shutdown`。
- 视觉全部自绘（配色 / 圆角 / hover / 进度条 / 开关 / 胶囊标签），不依赖 WebView；
  中文字体按 `ACFUN_UI_FONT` > 微软雅黑 > 等线 > 黑体 > 宋体 的顺序从系统加载（不分发字库，规避授权问题）。
- 通信层用「一个工作线程 + 300ms 轮询 `/api/tasks`」，不用 SSE —— 任务量小，但换来实现稳定、
  断线可自愈、UI 永不阻塞（提交/取消/重试/保存配置都在工作线程串行执行）。
- WebUI 保留：服务照旧伺服 `web/`，GUI 底栏有「在浏览器中打开 WebUI」，`--webui` 也能只开网页。
- 打包：`package:installer`（NSIS）与 `package:portable`（zip）共用同一个 `stage()`，内容完全一致。

**验收手段**（无窗口、可脚本化）：

- `AcFunDownload.exe --check` → 输出 `%TEMP%cfun-gui-check.json`：
  `{ok, version, font, cjkGlyphs, port, spawned, healthOk, configOk, tasksOk}`，
  其中 `cjkGlyphs` 用 egui 的 `Fonts::has_glyphs` 真实断言中文字形存在（杜绝豆腐块）。
