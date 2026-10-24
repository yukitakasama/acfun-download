/**
 * 打包公共步骤：构建（core/前端/服务端 bundle/原生 GUI）+ 组装暂存目录。
 *
 * 安装包（NSIS）与便携版（zip）共用这一份，保证两边内容完全一致：
 *   AcFunDownload.exe  原生 GUI（Rust/egui）
 *   node.exe           内置运行时（用户不需要装 Node）
 *   server/index.js    本地服务（下载逻辑都在这）
 *   web/               WebUI 构建产物（浏览器调试入口，GUI 底栏可打开）
 *   使用说明.txt / app.ico
 */
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(here, '..');
export const version = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).version;
export const distDir = join(repoRoot, 'dist');
export const launcherDir = join(repoRoot, 'packaging', 'launcher');
export const guiExe = join(launcherDir, 'target', 'release', 'AcFunDownload.exe');

export const log = (msg) => process.stderr.write(`[package] ${msg}\n`);

export function run(cmd, args, opts = {}) {
  log(`${cmd} ${args.map((a) => (a.includes(' ') ? `"${a}"` : a)).join(' ')}`);
  execFileSync(cmd, args, {
    cwd: opts.cwd ?? repoRoot,
    stdio: opts.stdio ?? 'inherit',
    shell: opts.shell ?? false,
    env: { ...process.env, MSYS_NO_PATHCONV: '1', ...(opts.env ?? {}) },
  });
}

function findCargo() {
  const candidates = [
    process.env.CARGO_PATH,
    join(process.env.USERPROFILE ?? '', '.cargo', 'bin', 'cargo.exe'),
  ];
  for (const p of candidates) if (p && existsSync(p)) return p;
  return 'cargo';
}

export function buildAll() {
  log('1/3 构建 core / 前端 / 服务端 bundle');
  run('pnpm', ['--filter', '@acfun/core', 'build'], { shell: true });
  run('pnpm', ['--filter', '@acfun/web', 'build'], { shell: true });
  run('pnpm', ['--filter', '@acfun/server', 'exec', 'tsup', '--config', 'tsup.sidecar.config.ts'], {
    shell: true,
  });

  log('2/3 编译原生 GUI（cargo build --release）');
  run(findCargo(), ['build', '--release', '--manifest-path', join(launcherDir, 'Cargo.toml')]);
  if (!existsSync(guiExe)) throw new Error(`GUI 产物不存在：${guiExe}`);
}

const README = (v) => `AcFun 视频下载 ${v}（Windows x64 · 原生桌面 GUI）
====================================================

双击 AcFunDownload.exe 打开原生窗口（Rust + egui，不依赖浏览器显示界面）。
窗口会自动在后台拉起本地服务（只监听 127.0.0.1、端口随机、一次性 token），
关闭窗口时若服务是本程序拉起的，会自动停掉，不留后台进程。

三种启动方式
  AcFunDownload.exe            打开桌面窗口（默认）
  AcFunDownload.exe --webui    不打开窗口，直接用浏览器打开 WebUI（调试/对比用）
  AcFunDownload.exe --shutdown 停掉后台服务（卸载程序、脚本用）
  AcFunDownload.exe --check    无窗口自检，结果写到 %TEMP%\\acfun-gui-check.json

界面速览
  顶栏     连接状态 / 成功率统计 / 设置 / 停止服务
  输入卡   粘贴多个链接或整段分享文本，Ctrl+Enter 直接开始；「解析预览」可先看世代与 pageId
  队列     每个任务一张卡片：状态、百分比、实时速度、已下载字节、x/y 分片、预计剩余；
           下载期百分比封顶 99.5%（不会假满格），核验阶段单独提示
  设置     输出目录、容器、重名策略、并发、浏览器通道、封面/元数据开关、外部工具路径
  底栏     本地服务地址、输出目录、打开目录、在浏览器中打开 WebUI

外部依赖（必需）
  ffmpeg / ffprobe —— 转封装与核验用，不随包提供。
  装好加入 PATH，或在「设置」里填完整路径（设置页会显示是否探测到）。

数据位置
  配置：%APPDATA%\\acfun-download\\config.json
  历史：%APPDATA%\\acfun-download\\history.json
  日志：%APPDATA%\\acfun-download\\server.log
  下载默认输出：%USERPROFILE%\\Downloads\\acfun（界面里可改）

便携版说明
  解压到任意目录直接运行，不写注册表、不建快捷方式；
  删除目录即卸载（%APPDATA%\\acfun-download 里的配置与历史不会被删）。

边界：只下载站点允许公开播放的内容；需登录/购买/预览一律停止；
     核验（全量解码 + 帧数/时长对清单）不可关闭，不通过不交付。
`;

export function stage(dir) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, 'server'), { recursive: true });
  mkdirSync(join(dir, 'web'), { recursive: true });

  const bundle = join(repoRoot, 'apps/server/dist-sidecar/index.js');
  const webDist = join(repoRoot, 'apps/web/dist');
  if (!existsSync(bundle)) throw new Error(`服务端 bundle 不存在: ${bundle}`);
  if (!existsSync(join(webDist, 'index.html'))) throw new Error(`前端产物不存在: ${webDist}`);

  copyFileSync(guiExe, join(dir, 'AcFunDownload.exe'));
  copyFileSync(join(launcherDir, 'app.ico'), join(dir, 'app.ico'));
  copyFileSync(process.execPath, join(dir, 'node.exe'));
  copyFileSync(bundle, join(dir, 'server', 'index.js'));
  writeFileSync(join(dir, 'server', 'package.json'), `${JSON.stringify({ type: 'module' }, null, 2)}\n`, 'utf8');
  cpSync(webDist, join(dir, 'web'), { recursive: true });
  writeFileSync(join(dir, '使用说明.txt'), README(version), 'utf8');

  const guiSize = statSync(join(dir, 'AcFunDownload.exe')).size;
  const nodeSize = statSync(join(dir, 'node.exe')).size;
  log(
    `暂存目录就绪：${dir}（GUI ${(guiSize / 1024 / 1024).toFixed(1)}MB + node ${(nodeSize / 1024 / 1024).toFixed(0)}MB）`,
  );
  return dir;
}
