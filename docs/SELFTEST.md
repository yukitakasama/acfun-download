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

## 用例 5（附加）：浏览器版绿色包 + ego 独立 space 跑通 GUI 全流程

**打包**（不打包任何原生 UI，GUI 就是浏览器里的网页）：

```bash
pnpm package:web
# dist/acfun-download-1.0.0-win-x64/{node.exe, server/index.js, web/**, 启动.cmd, 使用说明.txt}
# dist/acfun-download-1.0.0-win-x64.zip   33MB
```

**启动绿色包**（在包目录里，与用户双击 `启动.cmd` 同一条命令，只是去掉 `--open` 便于用 ego 打开）：

```bash
./node.exe server/index.js --port 0 --web-dir web
# {"type":"server","host":"127.0.0.1","port":50415,"token":"…","url":"http://127.0.0.1:50415/?token=…","pid":548}
# [acfun-server] 前端目录: web
# [acfun-server] ffmpeg version … / ego lite: ego-browser 0.6.0.22
```

**前端测试**：用 ego lite 新建**独立 space**（`acfun-frontend-test-mvmabrp2`）导航到该 URL，再用 DOM 操作驱动，
实测结果（原样摘录）：

| 步骤 | 实测 |
|---|---|
| 页面 | 标题 `AcFun 视频下载`；头部状态 `实时连接`（SSE 已连上） |
| 输入 | 粘贴分享文本 → `共 1 行有效输入` |
| 解析预览 | `世代NUXT / 类型post / pageId2164700 / 域名https://dlc1.8dbtby03.work / 判定依据：/_nuxt/ acpcssr.*.work`（约 3s 出结果） |
| 下载进度 | 采样值：`0 → 4.9 → 18.5 → 32.1 → 44 → 54.3 → 66.6 → 78.3 → 86.3 → 98.4 → 100` |
| 完成行 | `完成 · 100.0% · 已处理 2:42 · 213.2MB · C:\…\gui-dl-test\<标题>.mp4` |
| 设置页 | `ffmpeg version …`、`ego-browser 0.6.0.22` 均探测为 OK；字段齐全（输出目录/容器格式/重名处理/浏览器通道/ffmpeg 路径/代理） |
| 历史页 | 出现 `核验：` 数据（帧数 / 时长 / 清单时长） |
| space 收尾 | `task.finish({ keep: [] })`，不在用户窗口留残页 |

| 验收点 | 结果 |
|---|---|
| 绿色包不依赖目标机装 Node | ✓（跑的是包内 `node.exe`，无 node_modules） |
| GUI 全流程 | ✓ 粘贴 → 解析预览 → 下载 → 实时进度 → 日志/失败清单/历史 |
| 进度是真实推送 | ✓ 11 个采样点单调上升，来自 SSE `progress` 事件 |
| 设置持久化 | ✓ 写入 `%APPDATA%cfun-download\config.json`（测试后已还原/清理） |

## 用例 6：NSIS 安装程序 —— 点图标只开浏览器（无原生 UI）

```bash
pnpm package:installer
# → dist/AcFun下载-Setup-1.0.0.exe   22.4MB
# 安装数据 93.2MB → LZMA 压缩到 23.5MB（内含 node.exe 91.7MB + 服务端 bundle + 前端）
```

静默装到临时目录（等价于双击安装器一路下一步）：

```bash
AcFun下载-Setup-1.0.0.exe /S /D=<临时目录>
# exit=0
# 安装内容：AcFunDownload.exe(456KB 启动器) app.ico node.exe server/{index.js,package.json} web/** 使用说明.txt uninstall.exe
```

**点图标**（真实点击，未加任何测试环境变量）：

| 验收点 | 实测 |
|---|---|
| 不唤起原生 UI | ✓ 启动器 `windows_subsystem=windows`、服务 `CREATE_NO_WINDOW`，只有浏览器窗口 |
| 打开浏览器 | ✓ 走 `cmd /c start "" <url>`，URL 形如 `http://127.0.0.1:53241/?token=…` |
| 服务可用 | ✓ `GET /api/health` → `{"ok":true,"pid":32432,"version":"1.0.0"}` |
| 启动器自身退出 | ✓ `launcher exit=0`（不常驻、不留进程） |
| 运行信息落盘 | ✓ `%APPDATA%cfun-download\server.json`（port/token/pid/url） |
| 重复点击复用 | ✓ 第二次点击后 node 仍是同一个 pid（`node_count=1`） |
| 优雅关停 | ✓ `AcFunDownload.exe --shutdown` → 日志 `收到 HTTP /api/shutdown，停止任务并退出…`，`node_count=0`，`server.json` 已删 |
| 静默卸载 | ✓ `uninstall.exe /S` → 安装目录删除，`Uninstall` 注册表项、`Softwarecfun-download`、桌面/开始菜单快捷方式全部清空 |
| 卸载保留用户数据 | ✓ `%APPDATA%cfun-download`（配置/历史/日志）不删 |

> 过程中修掉的真问题：① 启动器里 `--shutdown` 的 HTTP 请求串被误写成裸 LF，导致服务不退出（已改回 CRLF）；
> ② `ACFUN_NO_BROWSER=` 空值被当成「测试模式」，已改成只认 `=1`；
> ③ 服务端 `--state-file` 的写入分支一开始没落进代码（启动器等不到运行信息），已补。

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
