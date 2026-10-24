# AcFun 视频下载工具

下载 AcFun 系列（马甲域 SPA）站点的公开视频：命令行 + 本地 Web GUI 双入口，共用同一套 core 业务逻辑。

> 仅下载站点**允许公开播放**的内容。需登录/购买/预览的内容一律停止并明确报错，不做任何绕过。
> 核验（全量解码 + 帧数/时长与清单比对）**不可关闭**，核验不过不得交付。

## 状态

开发中。里程碑与验收标准见 [`docs/PLAN.md`](docs/PLAN.md) §8。

| 里程碑 | 内容 | 状态 |
|---|---|---|
| M0 | pnpm workspace / tsconfig / vitest / README 骨架 | ✅ |
| M1 | 解析层（输入归一、站点世代判定） | ✅ |
| M2 | 命名层（清洗/模板/重名） | ✅ |
| M3 | 取清单（ego lite / Chrome 兜底） | ✅ |
| M4 | 下载核验（ffmpeg / 全量解码核验） | ✅ |
| M5 | 批量与报告 | ⬜ |
| M6 | 服务与 GUI | ⬜ |
| M7 | 桌面壳（Tauri 2，需 Rust + MSVC） | ⬜ |
| M8 | 交付（README / SELFTEST） | ⬜ |

## 目录结构

```
packages/core/   全部业务逻辑 + 单测（input/site/browser/manifest/download/naming/assets/report）
apps/cli/        acfun 命令行
apps/server/     本地服务（REST + SSE）
apps/web/        Vue 3 + Vite 前端
apps/desktop/    Tauri 2 壳
```

## 开发

```bash
pnpm install
pnpm build        # 构建全部 workspace 包
pnpm test         # 运行单测
pnpm typecheck    # 类型检查
```

## 外部依赖

| 依赖 | 必需性 | 说明 |
|---|---|---|
| Node ≥ 22 | 必需 | 运行时（原生 fetch / WebSocket） |
| ffmpeg / ffprobe | 必需 | 转封装与核验；不内嵌，需在 PATH 或配置路径 |
| ego-browser（ego lite） | 默认通道 | 复用用户真实 profile，天然带登录态 |
| Chrome | 兜底通道 | ego lite 不可用时用隔离 headless Chrome + CDP |

仅支持 Windows x64；不保证 macOS/Linux 可用。

## 关键 commit 与 tag

| tag | 内容 |
|---|---|
| `v0.0-skeleton` | M0 骨架 |
| `v0.1-parse` | M1 解析层 |
| `v0.2-naming` | M2 命名层 |
| `v0.3-manifest` | M3 取清单 |
| `v0.4-download` | M4 下载核验 |
