# 自测记录（SELFTEST）

> 记录日期：2026-10-24 · 本机 Windows x64 · Node v24.15.0 · ffmpeg/ffprobe（gyan essentials 2026-07-02）·
> ego-browser 0.6.0.22（ego lite 运行中）· 浏览器通道：**ego lite**（默认与推荐通道）
>
> 说明：马甲域与内容会轮换，**域名一律从输入推导，代码里没有硬编码**；下列链接仅代表当次实测。
> 所有命令均可在仓库根目录直接复现（`node apps/cli/dist/index.js …`，或装好后的 `acfun …`）。

---

## 用例 1：单视频（Vite 世代）—— 验证 aut 抓取 → 解密 → canWatch → 清单

```bash
node apps/cli/dist/index.js parse "https://dlc1.dpztxquz.work/play/267427"
```

真实输出（节选）：

```json
{
  "ok": true,
  "url": "https://dlc1.dpztxquz.work/play/267427",
  "origin": "https://dlc1.dpztxquz.work",
  "kind": "video",
  "pageId": "267427",
  "generation": "vite",
  "evidence": ["/assets/index-", "/_app.config.js"],
  "channel": "ego",
  "title": "<标题>（按页面原样取，此处隐去）",
  "segments": 157,
  "durationSec": 626,
  "hasEndlist": true,
  "playlistUrl": "https://dlc1.dpztxquz.work/api/m3u8/decode/authPath?path=jpd%2F20260801%2F2d%2Fah%2Fx3%2Fh0%2F<b64>.m3u8&auth_key=…&id=21415"
}
```

| 项 | 结果 |
|---|---|
| 世代判定 | `vite`（命中 `/assets/index-`、`/_app.config.js`） |
| 链路 | 抓 `aut` 头 → 签名重放 `getVideoById` → AES-128-CBC 解密 → `canWatch=true` → `authPath` |
| 清单 | 157 段 / **626.0s** / 有 `#EXT-X-ENDLIST`（完整 VOD，非预览） |
| 耗时 | ≈ 18s（含 ego 导航与等待访客登录流程发出 `aut`） |

> 该用例走的是**完整解析链路**；下载/核验环节由用例 2 的同一条代码路径覆盖（`resolveOne` → `downloadWithFfmpeg` → `verifyMedia`）。
> 观察到的一个真实坑：Vite 世代要等站点自己走完访客登录流程才会发出带 `aut` 的请求，
> 初次实测把抓取窗口设成 45s 时偶发抓不到，现已把默认窗口提到 **60s**（`capture.ts`）。

---

## 用例 2：社区帖（Nuxt 世代）—— 完整下载 + 全量解码核验

```bash
node apps/cli/dist/index.js dl "https://dlc1.8dbtby03.work/community/2164700" -o downloads
```

真实输出：

```
输出目录: D:\my-project\ACFUN-download\downloads
[1/1] 开始: https://dlc1.8dbtby03.work/community/2164700
[1/1] 解析中…
通道: ego lite；世代: nuxt
[1/1] 下载中…
开始下载：41 段 / 162.2s
[1/1] 核验中…
警告: 第 1 轮失败：VERIFY_FAILED: 解码报错: [h264 @ …] error while decoding MB 83 8, bytestream -6
整片重取清单重试（1000ms 后第 2 轮）…
[1/1] 解析中…
通道: ego lite；世代: nuxt
[1/1] 下载中…
开始下载：41 段 / 162.2s
[1/1] 核验中…
核验通过：4814 帧 / 162.3s / 221087892 字节

======== 汇总：成功 1 / 跳过 0 / 失败 0（共 1）========
✓ D:\my-project\ACFUN-download\downloads\上期有人说要原神玛薇卡的，我觉得这个比较.mp4 210.8MB | 4814 帧 / 162.3s
汇总报告: …\downloads\reports\20261024-172135-result.json
失败清单: …\downloads\reports\failures-20261024-172135.json
```

| 项 | 结果 |
|---|---|
| 帖子 id ≠ 视频 id | 是：`path`/`auth_key` 全部取自页面实发的 `public/decode/authPath`，未用 URL id 拼接口 |
| 首轮核验 | **抓到解码错误**（`error while decoding MB …`）—— 这正是「ffmpeg 自己 exit 0 但产物是坏的」的实测样本；核验拦住、删残件、整片重取清单重下 |
| 第二轮 | 4814 帧 / 162.3s / 221,087,892 字节，`-f null` 零输出，帧数 = 162.3 × 30fps ✓ |
| 产物 | `downloads/<标题>.mp4` + `<标题>.meta.json` |
| 退出码 | 0（成功） |

---

## 用例 3：批量（含故意不存在的 id）—— 独立成败 / 不串页 / exit 3 / 失败清单

`downloads/urls.txt`：

```
# 批量自测清单
// 第二条是故意不存在的 id

https://dlc1.8dbtby03.work/community/2164700
https://dlc1.8dbtby03.work/community/999999999
https://dlc1.8dbtby03.work/community/2164400
```

```bash
node apps/cli/dist/index.js batch -f downloads/urls.txt -o downloads --on-exist skip
```

真实输出（节选）：

```
输入 3 条
[1/3] … 已存在同名文件，按 --on-exist skip 跳过: …\上期有人说要原神玛薇卡的，我觉得这个比较.mp4
[2/3] … 警告: 第 1 轮失败：PARSE_FAILED: 页面返回 HTTP 500: …/community/999999999
[3/3] … 警告: 第 1 轮失败：PARSE_FAILED: 页面返回 HTTP 500: …/community/2164400

======== 汇总：成功 0 / 跳过 1 / 失败 2（共 3）========
```

```bash
echo $?   # => 3
```

`downloads/reports/failures-20261024-172455.json`：

```json
{
  "generatedAt": "2026-10-24T09:24:55.192Z",
  "count": 2,
  "failures": [
    {
      "url": "https://dlc1.8dbtby03.work/community/999999999",
      "taskId": "t2",
      "errorKind": "PARSE_FAILED",
      "message": "页面返回 HTTP 500: https://dlc1.8dbtby03.work/community/999999999",
      "suggestion": "站点返回 5xx：多为无效 id（该内容不存在）或边缘节点抖动。确认 id 有效后重试一轮。",
      "attempts": 1
    },
    { "url": "https://dlc1.8dbtby03.work/community/2164400", "taskId": "t3", "errorKind": "PARSE_FAILED", … }
  ]
}
```

`<ts>-result.json` 的 summary：`{"total":3,"success":0,"skipped":1,"failed":2}`。

| 验收点 | 结果 |
|---|---|
| 每条独立成败 | ✓（跳过 1 / 失败 2，互不影响） |
| 不串页 | ✓（不存在的 id 明确失败，没有被上一条的事件「救活」—— 该坑有单测回归：`browser.test.ts`） |
| 退出码 | ✓ 3 |
| 失败清单 | ✓ 2 条，每条带 `kind / message / suggestion / attempts` |
| 空行与 `#` `//` 注释 | ✓ 被忽略 |

---

## 用例 4（附加）：GUI 全流程 —— 用 ego lite 打开并跑通

启动本地服务（端口随机 + 一次性 token）：

```bash
node apps/server/dist/index.js --port 8787
# stdout 首行：{"type":"server","host":"127.0.0.1","port":8787,"token":"…","url":"http://127.0.0.1:8787/?token=…"}
```

用 ego lite 打开 `http://127.0.0.1:8787/?token=…`（`ego-browser nodejs` 注入脚本导航并操作 DOM），真实读到：

```
title: AcFun 视频下载 | textarea: true | 实时连接
共 1 行有效输入
解析预览 → 世代NUXT  类型post  pageId2164700  域名https://dlc1.8dbtby03.work
          判定依据：/_nuxt/  acpcssr.*.work
点「开始下载」后 → 任务队列：跳过 | 上期有人说要原神玛薇卡的，我觉得这个比较
                  D:\my-project\ACFUN-download\downloads\上期有人说要原神玛薇卡的，我觉得这个比较.mp4
日志：通道: ego lite；世代: nuxt
     已存在同名文件，按 --on-exist skip 跳过: …
```

| 验收点 | 结果 |
|---|---|
| 粘贴 → 解析预览 → 下载 → 看进度/日志 | ✓ |
| SSE 实时连接 | ✓（头部「实时连接」，事件 `hello/task/log/done` 依次到达） |
| 设置页环境探测 | ✓（`ffmpeg: ok`、`ego lite: ego-browser 0.6.0.22`） |
| 失败清单/历史面板 | ✓（读到历史 4 条、失败 1 条） |

---

## 用例 5（附加）：sidecar 独立运行（M7 未编译部分的可验证环节）

```bash
node apps/desktop/scripts/prepare-sidecar.mjs
apps/desktop/src-tauri/binaries/acfun-server-x86_64-pc-windows-msvc.exe \
  apps/desktop/src-tauri/resources/server/index.js \
  --port 0 --web-dir apps/desktop/src-tauri/resources/web
```

在**没有 node_modules** 的临时目录下运行，结果：

```
{"type":"server","host":"127.0.0.1","port":58745,"token":"…","url":"http://127.0.0.1:58745/?token=…","pid":36728}
[acfun-server] 前端目录: …\resources\web
[acfun-server] ffmpeg version … / ego lite: ego-browser 0.6.0.22
GET /            → 200（index.html）
GET /assets/…js  → 200 92294 字节
GET /api/env     → {"ffmpeg":{"ok":true},"ego":{"ok":true,"version":"ego-browser 0.6.0.22"}}
```

> `tauri build` 尚未执行：本机缺 rustc/cargo 与 MSVC（见 `apps/desktop/README.md`），属计划内挂起项。

---

## 单测

```bash
pnpm test
# Test Files  11 passed (11)
#      Tests  141 passed (141)
```

覆盖点（PLAN §7.1 / §7.2 要求项均已落地）：

| 文件 | 条数 | 覆盖 |
|---|---|---|
| `input.test.ts` | 20 | URL 抽取（中文/表情/全角标点）、尾部标点剥离、短链 302（mock）、去重、文件/stdin、纯 id |
| `site.test.ts` | 27 | 六种页面形态、query/hash、非法串、世代判定（fixture）、错误页标题、标题后缀剥离 |
| `naming.test.ts` | 37 | 非法字符/控制字符、结尾点与空格、200/201 边界、emoji 代理对、Windows 保留名、模板 5 占位符与空括号清理、日期格式、重名策略 |
| `manifest.test.ts` | 15 | 段数按 `#EXTINF`、时长累加、master 选最高码率、相对 URI 绝对化、auth_key 过期 |
| `browser.test.ts` | 10 | **串页防护回归**、authPath 抓取、非 HLS、多码率、Vite 解密 + canWatch、ego 脚本可序列化性 |
| `download.test.ts` | 8 | ffmpeg 参数、残件命名、真实 AES-128 HLS 转封装、**截断残件被拒**、0 字节、时长不符 |
| `pipeline.test.ts` | 7 | 1s→2s 退避时序（fake timers）、不可重试即停、Ctrl+C 落 `resume.json`、skip/rename、端到端 + sidecar |
| `concurrency.test.ts` | 5 | Mutex 串行、失败不卡链、并发上限、结果保序、interval、abort |
| `report.test.ts` | 9 | summary、JSON/CSV 结构、CSV 转义、落盘文件名 |
| `apps/cli/test/batch.test.ts` | 4 | **批量部分失败不被吞（exit 3 + failures 含条目）**、全成功 0、中断 130、汇总打印 |

---

## 复现清单（一键）

```bash
pnpm install
pnpm build            # core → cli → server
pnpm test             # 141 条单测
pnpm build:web        # 前端产物（GUI 需要）

node apps/cli/dist/index.js --version
node apps/cli/dist/index.js parse "<播放页或社区帖 URL>"
node apps/cli/dist/index.js dl   "<播放页或社区帖 URL>" -o downloads
node apps/cli/dist/index.js batch -f downloads/urls.txt -o downloads --on-exist skip

node apps/server/dist/index.js --port 8787   # 浏览器打开 stdout 里的 url
```
