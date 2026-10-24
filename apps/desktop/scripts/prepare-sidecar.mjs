/**
 * 准备 Tauri sidecar（M7）。
 *
 * 做三件事：
 *   1. 把 server 打成一个**自包含**的单文件 bundle（含 node_modules，noExternal）
 *   2. 把当前 Node 运行时复制成 sidecar 可执行文件：binaries/acfun-server-<target-triple>.exe
 *      （计划 Q13：exe 内嵌 Node runtime，不内嵌 ffmpeg）
 *   3. 把 bundle 放进 resources/server/，供壳层用 resource_dir 拼路径启动
 *
 * 前置：本机已装 Rust + MSVC（否则 tauri build 会失败，本脚本本身不依赖它们）。
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const desktopDir = resolve(here, '..');
const repoRoot = resolve(desktopDir, '../..');
const srcTauri = join(desktopDir, 'src-tauri');
const binariesDir = join(srcTauri, 'binaries');
const resourcesDir = join(srcTauri, 'resources', 'server');
const webResourceDir = join(srcTauri, 'resources', 'web');

/** 目标三元组：Windows x64（计划 Q14：仅 Windows x64）。 */
function targetTriple() {
  return process.env.TAURI_TARGET_TRIPLE ?? 'x86_64-pc-windows-msvc';
}

function run(cmd, args, cwd) {
  process.stderr.write(`[prepare-sidecar] ${cmd} ${args.join(' ')}\n`);
  execFileSync(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
}

function main() {
  const triple = targetTriple();
  if (!triple.includes('windows')) {
    throw new Error(`本工具仅支持 Windows x64（当前 triple=${triple}）`);
  }

  // 1) 构建自包含 server bundle + 前端产物
  run('pnpm', ['--filter', '@acfun/core', 'build'], repoRoot);
  run('pnpm', ['--filter', '@acfun/server', 'exec', 'tsup', '--config', 'tsup.sidecar.config.ts'], repoRoot);
  run('pnpm', ['--filter', '@acfun/web', 'build'], repoRoot);

  const bundle = join(repoRoot, 'apps/server/dist-sidecar/index.js');
  if (!existsSync(bundle)) throw new Error(`sidecar bundle 不存在: ${bundle}`);

  // 2) 复制 Node 运行时作 sidecar 可执行文件
  mkdirSync(binariesDir, { recursive: true });
  const nodeExe = process.execPath;
  const sidecarExe = join(binariesDir, `acfun-server-${triple}.exe`);
  copyFileSync(nodeExe, sidecarExe);
  process.stderr.write(`[prepare-sidecar] node ${process.version} → ${sidecarExe}\n`);

  // 3) bundle 放进 resources
  mkdirSync(resourcesDir, { recursive: true });
  copyFileSync(bundle, join(resourcesDir, 'index.js'));
  writeFileSync(
    join(resourcesDir, 'sidecar.json'),
    `${JSON.stringify({ triple, nodeVersion: process.version, builtAt: new Date().toISOString() }, null, 2)}\n`,
    'utf8',
  );

  // 4) 前端产物也放 resources：WebView 加载的是 sidecar 起的 http://127.0.0.1:<port>/?token=…，
  //    所以静态资源必须由 sidecar 伺服（不能只靠 Tauri 内嵌的 frontendDist）
  const webDist = join(repoRoot, 'apps/web/dist');
  if (!existsSync(join(webDist, 'index.html'))) throw new Error(`前端产物不存在: ${webDist}`);
  cpSync(webDist, webResourceDir, { recursive: true });

  process.stderr.write('[prepare-sidecar] 完成。现在可以 `pnpm --filter @acfun/desktop build`（需要 Rust + MSVC）。\n');
}

main();
