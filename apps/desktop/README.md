# apps/desktop —— Tauri 2 桌面壳（M7）

> **状态：脚手架就位，本机未编译。**
> 阻塞原因：本机缺 `rustup`（rustc/cargo）与 MSVC Build Tools（PLAN §2）。按计划 §10 的约定，
> M7 挂起、不阻塞 M0–M6 与 M8 的交付。
>
> 已经验证过的部分（不需要 Rust）：
> - `prepare-sidecar` 能把 server 打成 **314KB 自包含单文件**，把 Node 运行时复制成 sidecar（88MB）
> - sidecar 在**没有 node_modules 的目录**下能独立跑起来：打印握手 JSON、伺服 GUI、静态资源 200、
>   `/api/env` 正确探测到 ffmpeg 与 ego lite
>
> 待环境就绪后补：`tauri build` 出 exe、双击启动、关闭后无残留 node 进程、托盘与单实例。

## 壳层职责（业务一点不搬到 Rust）

1. 启动时拉起 sidecar：`acfun-server-<triple>.exe <resources>/server/index.js --port 0 --web-dir <resources>/web`
2. 读它 **stdout 首行**的握手 JSON：`{"type":"server","port":…,"token":…,"url":…,"pid":…}`
3. 用 `WebviewUrl::External(url)` **运行时创建窗口**（端口随机、token 一次性，写不进静态配置）
4. 单实例（`tauri-plugin-single-instance`）：再次双击只聚焦已有窗口，不新起服务
5. 托盘：显示窗口 / 退出
6. 退出时 `taskkill /PID <pid> /T /F` 收掉整棵进程树（连 ffmpeg、ego 子进程一起），不留残余 node

## 前置条件（Windows x64）

| 组件 | 用途 | 安装 |
|---|---|---|
| Node ≥ 22 | 构建与 sidecar 运行时 | 已具备 |
| Rust（rustup + stable-msvc） | 编译 Tauri | <https://win.rustup.rs> → `rustup default stable-x86_64-pc-windows-msvc` |
| MSVC Build Tools + Windows SDK | Rust 链接器 | VS Build Tools 勾选「使用 C++ 的桌面开发」 |
| WebView2 Runtime | Tauri 2 依赖 | 本机已具备（155.x） |

装好后自检：

```powershell
rustc --version; cargo --version
cd apps\desktop\src-tauri; cargo check
```

## 构建步骤

```bash
# 0) 置图标（首次需要；把一张 1024x1024 PNG 放到 apps/desktop/src-tauri/icon.png）
pnpm --filter @acfun/desktop exec tauri icon src-tauri/icon.png

# 1) 准备 sidecar（构建自包含 server bundle + 复制 node.exe + 打包前端）
node apps/desktop/scripts/prepare-sidecar.mjs

# 2) 编译安装包（NSIS）
pnpm --filter @acfun/desktop build
```

产物：`apps/desktop/src-tauri/target/release/bundle/nsis/*.exe`（约 100MB+，因为内嵌 Node 运行时；计划已确认接受）。

## 注意事项

- **不内嵌 ffmpeg**：启动时探测 PATH，读不到就在设置页黄色告警并引导填写路径（Q13）。
- `binaries/`、`resources/`、`target/` 都在 `.gitignore` 里（node.exe 88MB，不入库）。
- WebView 加载的是 sidecar 的 `http://127.0.0.1:<port>/?token=…`，所以前端产物必须由 sidecar 伺服
  （`resources/web`），不能只靠 Tauri 内嵌的 `frontendDist`。
- 只保证 Windows x64；不承诺 macOS/Linux（Q14）。
