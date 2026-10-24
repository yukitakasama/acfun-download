/**
 * 打包「安装程序」（NSIS）—— 安装后点图标只开浏览器，不唤起任何原生 UI。
 *
 * 流程：
 *   1. 构建：core → 前端 → 服务端自包含单文件 bundle
 *   2. 生成图标（app-icon.png → app.ico），编译资源（rc.exe）
 *   3. 编译启动器 AcFunDownload.exe（rustc，纯 std，无 crate 依赖）
 *   4. 组装暂存目录：AcFunDownload.exe / node.exe / server / web / 使用说明.txt / app.ico
 *   5. makensis 出安装包：dist/AcFun下载-Setup-<version>.exe
 *
 * 依赖（都在本机已有能力范围内）：
 *   - rustc（rustup）        ：编译启动器
 *   - rc.exe（Windows SDK）  ：编译图标资源
 *   - makensis（NSIS 3）     ：出安装包；找不到时依次查 PATH / Program Files / Tauri 缓存
 *   - ffmpeg                 ：生成图标（可选，已有 ico 就跳过）
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const version = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).version;
const distDir = join(repoRoot, 'dist');
const stageDir = join(distDir, 'installer-stage');
const launcherDir = join(repoRoot, 'packaging', 'launcher');
const launcherBuild = join(launcherDir, 'build');
const installerOut = join(distDir, `AcFun下载-Setup-${version}.exe`);

const log = (msg) => process.stderr.write(`[installer] ${msg}\n`);

function firstExisting(paths) {
  for (const p of paths) if (p && existsSync(p)) return p;
  return null;
}

function findRustc() {
  return firstExisting([
    process.env.RUSTC_PATH,
    join(process.env.USERPROFILE ?? '', '.cargo', 'bin', 'rustc.exe'),
    'C:/Users/yuki/.cargo/bin/rustc.exe',
  ]) ?? 'rustc';
}

function findRc() {
  const explicit = process.env.RC_PATH;
  if (explicit && existsSync(explicit)) return explicit;
  const kits = 'C:/Program Files (x86)/Windows Kits/10/bin';
  if (existsSync(kits)) {
    const versions = readdirSync(kits).filter((v) => /^\d+\.\d+\.\d+\.\d+$/.test(v)).sort().reverse();
    for (const v of versions) {
      const p = join(kits, v, 'x64', 'rc.exe');
      if (existsSync(p)) return p;
    }
  }
  const msvcRoot = 'C:/Program Files (x86)/Microsoft Visual Studio/2022/BuildTools/VC/Tools/MSVC';
  if (existsSync(msvcRoot)) {
    const vs = readdirSync(msvcRoot).sort().reverse();
    for (const v of vs) {
      const p = join(msvcRoot, v, 'bin', 'Hostx64', 'x64', 'rc.exe');
      if (existsSync(p)) return p;
    }
  }
  return null;
}

function findMakensis() {
  const explicit = process.env.MAKENSIS_PATH;
  if (explicit && existsSync(explicit)) return explicit;
  return firstExisting([
    'C:/Program Files (x86)/NSIS/makensis.exe',
    'C:/Program Files/NSIS/makensis.exe',
    join(process.env.LOCALAPPDATA ?? '', 'tauri', 'NSIS', 'Bin', 'makensis.exe'),
    join(process.env.LOCALAPPDATA ?? '', 'tauri', 'NSIS', 'makensis.exe'),
  ]);
}

function run(cmd, args, opts = {}) {
  log(`${cmd} ${args.map((a) => (a.includes(' ') ? `"${a}"` : a)).join(' ')}`);
  execFileSync(cmd, args, {
    cwd: opts.cwd ?? repoRoot,
    stdio: 'inherit',
    // Windows 上 pnpm 是 .cmd，必须走 shell 才能被解析到
    shell: opts.shell ?? false,
    env: { ...process.env, MSYS_NO_PATHCONV: '1', ...(opts.env ?? {}) },
  });
}

function ensureIcon() {
  const png = join(launcherDir, 'app-icon.png');
  const ico = join(launcherDir, 'app.ico');
  if (!existsSync(png)) {
    run('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'color=c=0xFD4C5B:s=512x512',
      '-vf', "drawtext=fontfile='C\\:/Windows/Fonts/arialbd.ttf':text='Ac':fontcolor=white:fontsize=230:x=(w-text_w)/2:y=(h-text_h)/2-10",
      '-frames:v', '1', png,
    ]);
  }
  if (!existsSync(ico)) {
    run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', png, '-vf', 'scale=256:256', ico]);
  }
  return ico;
}

function buildLauncher() {
  mkdirSync(launcherBuild, { recursive: true });
  const rc = findRc();
  if (!rc) throw new Error('找不到 rc.exe（需要 Windows SDK）。可用 RC_PATH 指定。');
  const sdk = 'C:/Program Files (x86)/Windows Kits/10/Include';
  const sdkVersion = existsSync(sdk)
    ? readdirSync(sdk).filter((v) => /^\d+\.\d+\.\d+\.\d+$/.test(v)).sort().reverse()[0]
    : undefined;
  const res = join(launcherBuild, 'app.res');
  const rcArgs = ['/nologo'];
  if (sdkVersion) {
    for (const sub of ['um', 'shared', 'winrt']) rcArgs.push(`/I${sdk}/${sdkVersion}/${sub}`);
  }
  rcArgs.push(`/fo`, res, join(launcherDir, 'app.rc'));
  run(rc, rcArgs, { cwd: launcherDir });

  const rustc = findRustc();
  const out = join(launcherBuild, 'AcFunDownload.exe');
  run(rustc, [
    '-O',
    '--edition', '2021',
    '-C', 'panic=abort',
    '-C', 'strip=symbols',
    join(launcherDir, 'src', 'main.rs'),
    '-o', out,
    '-C', `link-arg=${res}`,
  ], { cwd: launcherDir });
  return out;
}

function stage(launcherExe, ico) {
  rmSync(stageDir, { recursive: true, force: true });
  mkdirSync(join(stageDir, 'server'), { recursive: true });
  mkdirSync(join(stageDir, 'web'), { recursive: true });

  const bundle = join(repoRoot, 'apps/server/dist-sidecar/index.js');
  const webDist = join(repoRoot, 'apps/web/dist');
  if (!existsSync(bundle)) throw new Error(`服务端 bundle 不存在: ${bundle}`);
  if (!existsSync(join(webDist, 'index.html'))) throw new Error(`前端产物不存在: ${webDist}`);

  copyFileSync(launcherExe, join(stageDir, 'AcFunDownload.exe'));
  copyFileSync(ico, join(stageDir, 'app.ico'));
  copyFileSync(process.execPath, join(stageDir, 'node.exe'));
  copyFileSync(bundle, join(stageDir, 'server', 'index.js'));
  writeFileSync(join(stageDir, 'server', 'package.json'), `${JSON.stringify({ type: 'module' }, null, 2)}\n`, 'utf8');
  cpSync(webDist, join(stageDir, 'web'), { recursive: true });

  const readme = `AcFun 视频下载 ${version}（Windows x64）
=====================================

点击桌面/开始菜单的「AcFun 下载」图标：
  1) 后台启动本地服务（只监听 127.0.0.1，端口随机，一次性 token）
  2) 用默认浏览器打开界面（没有任何原生窗口）
  重复点击只会复用已在跑的服务，不会再开一个。

停止服务：界面右上角「退出服务」，或运行 AcFunDownload.exe --shutdown。

外部依赖（必需）：
  ffmpeg / ffprobe —— 转封装与核验用，不随安装包提供。
  装好加入 PATH，或在界面「设置」里填写完整路径（设置页会显示是否探测到）。

数据位置：
  配置：%APPDATA%\\acfun-download\\config.json
  历史：%APPDATA%\\acfun-download\\history.json
  日志：%APPDATA%\\acfun-download\\server.log
  下载默认输出到：%USERPROFILE%\\Downloads\\acfun（界面里可改）

边界：只下载站点允许公开播放的内容；需登录/购买/预览一律停止；
     核验（全量解码 + 帧数/时长对清单）不可关闭，不通过不交付。
`;
  writeFileSync(join(stageDir, '使用说明.txt'), readme, 'utf8');

  const size = statSync(join(stageDir, 'node.exe')).size;
  log(`暂存目录就绪：${stageDir}（node.exe ${(size / 1024 / 1024).toFixed(0)}MB）`);
}

function buildInstaller() {
  const makensis = findMakensis();
  if (!makensis) {
    throw new Error('找不到 makensis（NSIS）。装一个：winget install NSIS.NSIS，或用 MAKENSIS_PATH 指定。');
  }
  rmSync(installerOut, { force: true });
  run(makensis, [
    '/INPUTCHARSET', 'UTF8',
    `/DAPP_VERSION=${version}`,
    `/DSTAGE_DIR=${stageDir}`,
    `/DOUT_FILE=${installerOut}`,
    `/DICON_FILE=${join(stageDir, 'app.ico')}`,
    join(repoRoot, 'packaging', 'installer.nsi'),
  ]);
  if (!existsSync(installerOut)) throw new Error('安装包没有生成');
  log(`安装包：${installerOut}（${(statSync(installerOut).size / 1024 / 1024).toFixed(1)}MB）`);
}

function main() {
  if (process.platform !== 'win32') throw new Error('仅支持 Windows x64 打包');

  log('1/5 构建 core / 前端 / 服务端 bundle');
  run('pnpm', ['--filter', '@acfun/core', 'build'], { shell: true });
  run('pnpm', ['--filter', '@acfun/web', 'build'], { shell: true });
  run('pnpm', ['--filter', '@acfun/server', 'exec', 'tsup', '--config', 'tsup.sidecar.config.ts'], { shell: true });

  log('2/5 生成图标');
  const ico = ensureIcon();

  log('3/5 编译启动器（rc + rustc）');
  const launcherExe = buildLauncher();

  log('4/5 组装暂存目录');
  stage(launcherExe, ico);

  log('5/5 打包安装程序');
  buildInstaller();
}

main();
