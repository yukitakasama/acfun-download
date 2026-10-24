/**
 * 打包「浏览器版」绿色包（不打包任何原生 UI）。
 *
 * 产物：`dist/acfun-download-<version>-win-x64/`
 *   node.exe                内嵌 Node 运行时（不依赖用户装 Node）
 *   server/index.js         自包含服务端 bundle（含全部依赖，无 node_modules）
 *   web/**                  前端静态资源（GUI 就是浏览器里的网页）
 *   启动.cmd                双击 → 启动本地服务 → 用默认浏览器打开 GUI
 *   使用说明.txt
 * 以及同名 zip。
 *
 * 说明：GUI 完全跑在浏览器里（本地服务在 127.0.0.1 随机端口 + 一次性 token）。
 * 推荐用 ego lite 打开该链接（与下载用的浏览器通道一致，便于对照）。
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const version = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).version;
const outRoot = join(repoRoot, 'dist');
const pkgDir = join(outRoot, `acfun-download-${version}-win-x64`);
const zipPath = `${pkgDir}.zip`;

function run(cmd, args, cwd = repoRoot) {
  process.stderr.write(`[package] ${cmd} ${args.join(' ')}\n`);
  execFileSync(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
}

function main() {
  if (process.platform !== 'win32') throw new Error('仅支持 Windows x64 打包');

  // 1) 构建：core → 前端 → 服务端自包含 bundle
  run('pnpm', ['--filter', '@acfun/core', 'build']);
  run('pnpm', ['--filter', '@acfun/web', 'build']);
  run('pnpm', ['--filter', '@acfun/server', 'exec', 'tsup', '--config', 'tsup.sidecar.config.ts']);

  const bundle = join(repoRoot, 'apps/server/dist-sidecar/index.js');
  const webDist = join(repoRoot, 'apps/web/dist');
  if (!existsSync(bundle)) throw new Error(`服务端 bundle 不存在: ${bundle}`);
  if (!existsSync(join(webDist, 'index.html'))) throw new Error(`前端产物不存在: ${webDist}`);

  // 2) 组装目录
  rmSync(pkgDir, { recursive: true, force: true });
  mkdirSync(join(pkgDir, 'server'), { recursive: true });
  mkdirSync(join(pkgDir, 'web'), { recursive: true });

  // 内嵌 Node 运行时（Q13：exe/包里带 Node，不内嵌 ffmpeg）
  copyFileSync(process.execPath, join(pkgDir, 'node.exe'));
  copyFileSync(bundle, join(pkgDir, 'server', 'index.js'));
  // 让 node 直接按 ESM 解析，避免 MODULE_TYPELESS_PACKAGE_JSON 的重新解析告警
  writeFileSync(join(pkgDir, 'server', 'package.json'), `${JSON.stringify({ type: 'module' }, null, 2)}
`, 'utf8');
  cpSync(webDist, join(pkgDir, 'web'), { recursive: true });

  // 批处理内容必须是 ASCII：cmd.exe 按控制台 OEM 代码页解析 .cmd 文件，
  // 文件里写中文会被解析坏（实测会吞行、报「不是内部或外部命令」）。
  // 开头先 chcp 65001 切到 UTF-8，node 自己输出的中文日志就能正常显示。
  const launcher = [
    '@echo off',
    'chcp 65001 >nul',
    'setlocal',
    'set "HERE=%~dp0"',
    'echo Starting AcFun Download (local server + browser GUI)...',
    'echo.',
    `"%HERE%node.exe" "%HERE%server\\index.js" --port 0 --web-dir "%HERE%web" --open`,
    'echo.',
    'echo Server stopped. Press any key to close this window.',
    'pause >nul',
    '',
  ].join('\r\n');
  writeFileSync(join(pkgDir, '启动.cmd'), launcher, 'utf8');

  const readme = `AcFun 视频下载 ${version}（浏览器版 · Windows x64）
=================================================

双击「启动.cmd」即可：
  1) 用内置的 node.exe 启动本地服务（只监听 127.0.0.1，端口随机，带一次性 token）
  2) 自动用默认浏览器打开 GUI

GUI 是纯网页，没有原生窗口。关闭「启动.cmd」的黑窗口 = 停止服务。

推荐用 ego lite 打开它打印的链接：
  ego lite 与下载用的是同一个浏览器，便于对照；也更不容易被站点风控。

外部依赖（必需）：
  ffmpeg / ffprobe —— 转封装与核验用，不内嵌。装好后加入 PATH，
  或在 GUI 的「设置」里填写完整路径（设置页顶部会显示是否探测到）。

数据位置：
  配置：%APPDATA%\\acfun-download\\config.json
  历史：%APPDATA%\\acfun-download\\history.json
  下载默认输出到「启动.cmd 所在目录 / downloads」。

边界：只下载站点允许公开播放的内容；需登录/购买/预览一律停止；
     核验（全量解码 + 帧数/时长对清单）不可关闭，不通过不交付。
`;
  writeFileSync(join(pkgDir, '使用说明.txt'), readme, 'utf8');

  // 3) 打 zip
  rmSync(zipPath, { force: true });
  const ps = `Compress-Archive -Path '${pkgDir}' -DestinationPath '${zipPath}' -Force`;
  run('powershell.exe', ['-NoProfile', '-Command', ps]);

  process.stderr.write(`\n[package] 目录: ${pkgDir}\n[package] 压缩包: ${zipPath}\n`);
}

main();
