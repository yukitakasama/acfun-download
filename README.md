# AcFun 视频下载工具

下载 AcFun 系列（马甲域 SPA）站点的**公开视频**：命令行 + 本地 Web GUI 双入口，共用同一套 core 业务逻辑。
只做三件事：**取清单 → ffmpeg 转封装 → 全量解码核验**。核验不过不交付。

> ### 边界声明（硬编码，不可配置关闭）
>
> - 只下载站点**允许公开播放**的内容：Vite 世代要求 `canWatch === true`；Nuxt 世代要求
>   `authPath` 为免鉴权 `public` 接口且正常返回 `#EXTM3U`。
> - 只拿到 `previewUrl`（预览）、需登录、需购买 —— **一律停止**，不做任何绕过。
> - **核验不可关闭**（没有 `--no-verify`）。ffmpeg 丢了分片照样 exit 0，
>   所以必须全量解码 + 帧数/时长对清单，才能证明"真的下全了"。
> - 站点对无效 id 会回退播放别的内容，所以**页面标题是错误页就停止交付**，避免交付错视频。

## 状态

| 里程碑 | 内容 | 状态 |
|---|---|---|
| M0 | pnpm workspace / tsconfig / vitest / README 骨架 | ✅ `v0.0-skeleton` |
| M1 | 解析层（输入归一、站点世代判定、ID 归一） | ✅ `v0.1-parse` |
| M2 | 命名层（清洗 / 模板 / 重名 / 序号） | ✅ `v0.2-naming` |
| M3 | 取清单（ego lite + Chrome/CDP 兜底 + 两代链路 + 安全边界） | ✅ `v0.3-manifest` |
| M4 | 下载核验（ffmpeg 转封装 / 进度 / 全量解码核验 / 两轮重试） | ✅ `v0.4-download` |
| M5 | 批量与报告（队列 / 并发语义 / 续传 / 汇总 / 失败清单） | ✅ `v0.5-batch` |
| M6 | 服务与 GUI（Hono REST+SSE / Vue 3 / 配置持久化） | ✅ `v0.6-gui` |
| M7 | ~~桌面壳（Tauri 2 原生窗口）~~ | ❌ **取消**：按需求变更，GUI 走浏览器，不打包原生 UI |
| M8 | 交付（README / SELFTEST / 单测报告 / 安装程序） | ✅ `v1.0` → `v1.3` |

真实自测记录见 [`docs/SELFTEST.md`](docs/SELFTEST.md)，计划与需求确认见 [`docs/PLAN.md`](docs/PLAN.md)。

## 环境要求

仅支持 **Windows x64**（不保证 macOS/Linux）。

| 依赖 | 必需性 | 说明 |
|---|---|---|
| Node ≥ 22 | 必需 | 原生 `fetch` / `WebSocket`，无需第三方 HTTP 库 |
| **ffmpeg / ffprobe** | **必需** | 转封装与核验；**不内嵌**，需在 PATH 或配置里填路径 |
| **ego-browser（ego lite）** | **必需（默认通道）** | 复用用户真实 profile：天然带登录态、更少被 WAF 拦、更不容易触发风控 |
| Chrome / Edge | 可选（最后兜底） | 仅在 ego lite 不可用时使用；本机以 ego lite 为准，**不推荐**使用此通道 |

## 安装

```bash
git clone <repo> && cd ACFUN-download
pnpm install
pnpm build          # 构建 core / cli / server
pnpm build:web      # 构建前端（GUI 需要）
```

命令行入口：`node apps/cli/dist/index.js <command> …`（`apps/cli/package.json` 里已声明 `bin: acfun`，
`pnpm link --global` 或 `npm i -g .` 后可直接用 `acfun`）。

## 快速开始

### CLI

```bash
# 只解析（不下载）—— 先看世代/段数/时长/码率，确认解析对路
acfun parse "https://<马甲域>/community/2164700"

# 下载单条
acfun dl "https://<马甲域>/play/267427" -o D:/好看的

# 分享文本（含中文/表情/全角标点也能提取）
acfun dl "【日常分享】快来看 https://<马甲域>/community/2164411 🎉"

# 批量（文件里可写 # 与 // 注释、空行）
acfun batch -f urls.txt -o D:/好看的 --on-exist skip

# 从管道读
cat urls.txt | acfun dl -

# 纯 id（配 --origin）
acfun dl 2164411 2164502 --origin https://<马甲域> -o D:/好看的
```

### GUI

```bash
node apps/server/dist/index.js --port 8787
# stdout 首行：{"type":"server","port":8787,"token":"…","url":"http://127.0.0.1:8787/?token=…"}
```

把那条 `url` 粘到浏览器（推荐用 **ego lite** 打开，和下载用的浏览器通道一致，方便对照）即可。

或者直接装打包好的安装程序（见下文「打包 / 安装」）：装完点桌面图标，它会起本地服务并把 GUI 交给浏览器。
界面分 4 块：

1. **输入 + 解析预览** —— 粘贴链接/分享文本，先看世代、页面类型、pageId（判定错了当场就能发现）
2. **任务队列 + 实时进度** —— 状态、百分比、**实时速度（MB/s）**、已下载字节、**已下载段数 x/y**、
   已处理时长、预计剩余；下载期百分比封顶 99.5%（不会「假满格」），核验阶段单独提示；可取消 / 重试
3. **设置** —— 输出目录、命名、容器、并发、超时、通道、ffmpeg 路径；顶部显示 ffmpeg / ego lite 环境探测结果，
   缺 ffmpeg 时黄色告警并允许手填路径
4. **日志 / 失败清单 / 历史** —— 失败条目带 `kind + message + suggestion`，可一键复制链接

配置持久化在 `%APPDATA%\acfun-download\config.json`（仓库外，不进 git）。历史在 `%APPDATA%\acfun-download\history.json`。

> 服务只绑 `127.0.0.1`，端口 `0`（系统分配），REST 与 SSE 都要一次性 token —— 别的进程猜不到端口，
> 也拿不到 token。

## CLI 参数

```
用法: acfun <command> [inputs...] [options]

命令
  dl      <input...>   下载（支持 URL / 分享文本 / 多个）
  parse   <input...>   只解析，输出 JSON（不下载）——自测与调试用
  batch   -f <file>    批量（等价 dl -f，语义更明确）

输入
  <url|分享文本|id>    位置参数，可多个
  -                    从 stdin 读取

选项
  -f, --file <path>                 文本清单（按行读取，忽略空行 / # / //）
  -o, --out-dir <dir>               输出目录（默认 ./downloads）
  --name-mode title|custom          命名模式（默认 title）
  --name <fixed-name>               custom 模式的固定名
  --template <tpl>                  custom 模式模板，如 "{title} [{author}] {date} {id}"
  --on-exist rename|skip|overwrite  重名处理（默认 rename）
  --container mp4|mkv|ts            容器格式（-c copy 转封装，不重编码）（默认 mp4）
  --meta                            写 .meta.json 元数据 sidecar（默认 true）
  --cover                           下载封面（默认 true）
  --danmaku                         下载弹幕（实验性，默认 false）
  --subtitle                        下载字幕（实验性，默认 false）
  --concurrency <n>                 并发度，仅并行 ffmpeg 阶段（默认 1）
  --retries <n>                     整片重取清单轮数（默认 2）
  --timeout <sec>                   请求/导航超时（默认 30）
  --interval <ms>                   任务间隔（默认 1500）
  --proxy <url>                     代理（默认关；ego 通道不支持时回落 Chrome）
  --cookie <file>                   仅 Chrome 兜底通道；亦可用 ACFUN_COOKIE
  --resume                          复用未过期清单恢复未完成任务（默认 false）
  --report json|csv                 汇总报告格式（默认 json）
  --json                            进度与结果以 NDJSON 输出到 stdout（默认 false）
  -v, --verbose                     详细日志（默认 false）
  --origin <url>                    纯 id 输入的基准域名
  --config <path>                   配置文件路径
  --ffmpeg <path>                   ffmpeg 可执行文件路径
  --ffprobe <path>                  ffprobe 可执行文件路径
  --chrome <path>                   Chrome/Edge 可执行文件路径（兜底通道）
  --channel auto|ego|chrome         浏览器通道（默认 auto = ego 优先，不可用回落 Chrome）
```

**`--concurrency > 1` 的真实语义**：只并行 **ffmpeg 下载/核验**阶段；**浏览器取清单阶段恒串行**。
ego lite 是单实例 + 用户真实 profile，并行会互抢标签页且更容易触发风控。

### 退出码

| 码 | 含义 |
|---|---|
| 0 | 全部成功（含 skip） |
| 1 | 参数/环境错误（含 ffmpeg 缺失） |
| 3 | 部分或全部失败（失败条目写进 `reports/failures-<ts>.json`） |
| 130 | 用户中断（Ctrl+C，保留 `.part`，可用 `--resume` 继续） |

## 打包 / 安装（NSIS 安装程序）

GUI 是纯网页，所以"打包"= 把**运行时 + 本地服务 + 前端 + 一个只负责开浏览器的启动器**装进安装程序：

```bash
pnpm package:installer
# → dist/AcFun下载-Setup-<version>.exe（约 22MB，内含 Node 运行时）
```

**安装后怎么用**：桌面/开始菜单会出现带图标的「AcFun 下载」。点它：

1. 后台启动本地服务（`127.0.0.1`、随机端口、一次性 token，`CREATE_NO_WINDOW`，没有控制台窗口）
2. 用**默认浏览器**打开界面 —— **不唤起任何原生 UI**（没有窗口、没有托盘）
3. 启动器自己立刻退出；再点图标只会复用已在跑的服务，不会再起第二个

**停止服务**：界面右上角「退出服务」按钮，或 `"<安装目录>\AcFunDownload.exe" --shutdown`。

安装细节：

| 项 | 值 |
|---|---|
| 安装位置 | `%LOCALAPPDATA%\Programs\AcFun下载`（按用户安装，不弹 UAC） |
| 卸载 | 设置 →「应用」里卸载，或开始菜单「卸载 AcFun 下载」 |
| 卸载保留 | `%APPDATA%cfun-download`（配置 / 历史 / 日志）**不删** |
| 运行日志 | `%APPDATA%cfun-download\server.log` |
| 内嵌 | Node 运行时（`node.exe`）、服务端单文件 bundle、前端静态资源 |
| 不内嵌 | ffmpeg / ffprobe（必需，装好后在 PATH 里，或界面设置页填路径） |

打包依赖（本机一次装好即可）：`rustc`（编译启动器）、`rc.exe`（Windows SDK，编图标资源）、
`makensis`（NSIS 3；`winget install NSIS.NSIS`，或自动复用 Tauri 缓存里的 NSIS）。

## 产物

```
downloads/
├─ <标题>.mp4                     交付文件（已通过全量解码核验才改名）
├─ <标题>.meta.json               元数据 sidecar（清单段数/时长/码率、核验帧数、下载时间）
├─ <标题>.jpg                     封面（页面 og:image）
├─ <标题>.part.mp4                下载中/中断残件（.part / .retryN / .part.stale-<ts>）
└─ reports/
   ├─ <ts>-result.json|csv        全量结果汇总（含每条任务状态）
   ├─ failures-<ts>.json          只含失败条目（带 kind/message/suggestion）
   └─ resume-<taskId>.json        中断时的续传状态
```

命名规则（`--name-mode title|custom`）：

- 清洗顺序固定：非法字符 `\ / : * ? " < > |` 与控制字符 → `_` → 连续空白压单空格 → 去首尾空格与结尾 `.`
  → 按码点截断到 `200 - 扩展名长度` → 空则回退 `acfun-<id>` → 避开 Windows 保留名（`CON/PRN/AUX/NUL/COM1-9/LPT1-9`）
- 模板占位符：`{title} {author} {date} {id} {index}`；缺字段**不留空括号**（`"{title} [{author}]"` 缺 author → 只剩标题）
- 批量 `{index}` 三位补零、按**输入顺序**（不是完成顺序）

## 错误分类

任何失败都有 `kind + message + suggestion`（禁止静默失败与空文件）：

| kind | 触发 | 是否重试 | 建议要点 |
|---|---|---|---|
| `NET_TIMEOUT` | fetch/goto 超时 | 是（1s→2s→4s） | 查网络/代理；马甲域偶发 RST 重跑即可 |
| `EDGE_RESET` | `ERR_CONNECTION_RESET` | 是 | 边缘节点随机重置，重跑一轮 |
| `HTTP_403` / `HTTP_404` | 清单或分片返回 | 是 | 签名分钟级过期；或内容已下架 |
| `AUTH_REQUIRED` | `canWatch=false` / 抓不到 `authPath` | **否** | 需登录/购买，本工具不绕过 |
| `MANIFEST_NOT_HLS` | 返回非 `#EXTM3U` | 否 | 内容不可公开播放 |
| `PAGE_ERROR_TITLE` | 标题像错误页 | 否 | 站点对无效 id 会回退播放别的内容，已拦截 |
| `PARSE_FAILED` / `SITE_UNKNOWN` | 世代无法判定 / 页面 5xx | 否 | 查域名形态、是否需代理、id 是否有效 |
| `OFFICIAL_UNSUPPORTED` | 官方站取不到流 | 否 | 官方站需另做逆向，属已知限制 |
| `FFMPEG_MISSING` | PATH 找不到 | 启动即失败 | 装 ffmpeg 或设置路径 |
| `FFMPEG_FAILED` / `VERIFY_FAILED` | 转封装失败 / 核验不过 | 是 | 疑似丢分片，整片重取清单 |
| `BROWSER_UNAVAILABLE` | ego/Chrome 起不来 | — | 确认 ego lite 在运行 |
| `USER_ABORT` | Ctrl+C | — | 保留 `.part`，用 `--resume` 继续 |

## FAQ

**Q：马甲域老是变 / 报 SITE_UNKNOWN？**
域名一律从你给的输入推导，代码里没有硬编码。若 HTML 里既没有 `/_nuxt/`、`acpcssr.*.work`，也没有
`/assets/index-`，就会报 `SITE_UNKNOWN`——通常是域名换了形态、被 WAF 拦、或需要代理。

**Q：为什么 `parse` 有时要十几秒？**
Vite 世代要等站点自己走完访客登录流程才会发出带 `aut` 头的请求（实测可达 40s+），
下载阶段还要再等导航与起播。这是站点的节奏，不是卡住了。

**Q：为什么下到一半失败的会整片重下，而不是断点续传？**
分片签名只有几分钟时效，续传窗口太短。默认策略是"重取清单、整片重下"（`--retries` 控制轮数，轮间退避
1s→2s→4s）。`--resume` 是**简版续传**：清单签名还有效就先核验已有 `.part`，干净就直接转正；
签名过期就把旧残件改名 `.part.stale-<ts>` 保留（不删用户数据）再整片重下。

**Q：`--concurrency 4` 为什么感觉没快多少？**
因为浏览器取清单阶段**恒串行**（ego lite 单实例共享用户 profile）。并发只作用于 ffmpeg 阶段。
这是刻意的：并行开任务空间会互抢标签页、更容易触发风控。

**Q：官方站 `www.acfun.cn/v/ac…` 能用吗？**
只做**尽力解析**（找页面里的 HLS 线索），取不到就明确报 `OFFICIAL_UNSUPPORTED`，不产出空文件。
属已知限制，建议改用马甲域链接。

**Q：弹幕 / 字幕？**
默认关闭、标注实验性。两代前端都没有稳定的公开弹幕接口，本版只告警不下载，**不影响主流程**。

**Q：Chrome 兜底通道？**
代码保留（ego lite 缺失时的最后手段），但**不推荐**：本机的默认与验证通道都是 ego lite。
显式指定 `--channel chrome` 时会提示优先用 ego。

**Q：会覆盖我已有的文件吗？**
不会。已完成成品永不隐式覆盖；重名默认 `rename`（`-1`/`-2`），`--on-exist overwrite` 才覆盖。

## 目录结构

```
packages/core/   全部业务逻辑 + 单测
  src/input/     输入归一（URL/分享文本/短链/文件/stdin）
  src/site/      站点与世代判定、ID 归一、官方站尽力解析
  src/browser/   取清单：ego lite 通道 + Chrome/CDP 兜底（同一份 captureRound 逻辑）
  src/manifest/  清单解析、多码率选择、URI 绝对化、auth_key 过期
  src/download/  ffmpeg 转封装、进度、全量解码核验
  src/naming/    清洗、模板、重名
  src/assets/    meta sidecar、封面、弹幕/字幕（实验性）
  src/report/    汇总 JSON/CSV、失败清单
  src/pipeline.ts 单条任务流水线（重试 / .part / 续传 / 副作用）
  src/errors.ts  错误分类 + 建议
  test/          vitest 单测（141 条）
apps/cli/        acfun 命令行
apps/server/     本地服务（Hono REST + SSE）
apps/web/        Vue 3 + Vite 前端（GUI 就是浏览器里的网页）
scripts/         打包脚本（package-installer.mjs）
packaging/       启动器（Rust，只开浏览器）+ NSIS 安装脚本 + 图标
docs/            PLAN.md / SELFTEST.md
```

## 开发

```bash
pnpm install
pnpm build        # core → cli → server
pnpm test         # 141 条单测（含真实 ffmpeg 集成测试：AES-128 HLS 转封装、截断残件被拒）
pnpm typecheck    # 三个包的类型检查
pnpm build:web    # 前端产物
pnpm dev:web      # 单独调前端（vite 代理 /api 到 127.0.0.1:8787）
pnpm package:installer  # 打 NSIS 安装程序（dist/AcFun下载-Setup-<ver>.exe）
```

约定：主干任一 commit 都能构建/跑单测；每个里程碑一个提交 + 一个 tag。

## 关键 commit 与 tag

| tag | 内容 |
|---|---|
| `v0.0-skeleton` | M0 骨架：pnpm workspace + tsconfig + vitest |
| `v0.1-parse` | M1 解析层：输入归一 + 世代判定 + ID 归一 |
| `v0.2-naming` | M2 命名层：清洗 / 模板 / 重名 |
| `v0.3-manifest` | M3 取清单：ego lite 通道 + Chrome 兜底 + 两代链路 + 安全边界 |
| `v0.4-download` | M4 下载核验：ffmpeg 转封装 + 全量解码核验 + 两轮重试 |
| `v0.5-batch` | M5 批量与报告：队列 / 并发语义 / 续传 / 失败清单 |
| `v0.6-gui` | M6 服务与 GUI：Hono REST+SSE + Vue 3 |
| `v1.0` | M8 交付：README + SELFTEST + 单测报告 |
| `v1.1` | 取消原生壳，改为浏览器版绿色包 + 打包脚本 + 端到端 GUI 自测 |
| `v1.2` | NSIS 安装程序：点图标只开浏览器（无原生 UI）+ 启动器复用/关停 + 卸载验收 |
| `v1.3` | 修复进度显示：段级真实进度 + 速度/字节/ETA，运行期封顶 99.5，不再假满格 |

M7 原生壳已按需求取消（GUI 走浏览器）；如以后仍想做原生窗口，`docs/PLAN.md` 末尾记录了当时的取舍。

## 已知限制

1. 仅 Windows x64。
2. 官方站（`www.acfun.cn`）只做尽力解析，可能整段不可用。
3. 弹幕 / 字幕未实现（实验性占位，只告警）。
4. GUI 跑在浏览器里（本地服务 + 网页），**没有原生窗口/托盘**；安装程序内嵌 Node 运行时，点图标即用。
5. 马甲域边缘节点会随机 RST、分片签名分钟级过期 —— 都靠"整片重取清单"兜，不是无限重试。
