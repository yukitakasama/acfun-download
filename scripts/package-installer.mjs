/**
 * 打包「安装程序」（NSIS）。
 *
 * 产出：dist/AcFun下载-Setup-<version>.exe
 * 内容与便携版完全一致（见 package-shared.mjs），只是多了开始菜单/桌面快捷方式与卸载信息。
 */
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { buildAll, distDir, log, repoRoot, run, stage, version } from './package-shared.mjs';

const stageDir = join(distDir, 'installer-stage');
const installerOut = join(distDir, `AcFun下载-Setup-${version}.exe`);

function findMakensis() {
  const explicit = process.env.MAKENSIS_PATH;
  if (explicit && existsSync(explicit)) return explicit;
  const candidates = [
    'C:/Program Files (x86)/NSIS/makensis.exe',
    'C:/Program Files/NSIS/makensis.exe',
    join(process.env.LOCALAPPDATA ?? '', 'tauri', 'NSIS', 'Bin', 'makensis.exe'),
    join(process.env.LOCALAPPDATA ?? '', 'tauri', 'NSIS', 'makensis.exe'),
  ];
  for (const p of candidates) if (p && existsSync(p)) return p;
  return null;
}

function main() {
  if (process.platform !== 'win32') throw new Error('仅支持 Windows x64 打包');

  buildAll();

  log('3/3 组装安装包');
  stage(stageDir);

  const makensis = findMakensis();
  if (!makensis) {
    throw new Error('找不到 makensis（NSIS）。装一个：winget install NSIS.NSIS，或用 MAKENSIS_PATH 指定。');
  }
  rmSync(installerOut, { force: true });
  run(makensis, [
    '/INPUTCHARSET',
    'UTF8',
    `/DAPP_VERSION=${version}`,
    `/DSTAGE_DIR=${stageDir}`,
    `/DOUT_FILE=${installerOut}`,
    `/DICON_FILE=${join(stageDir, 'app.ico')}`,
    join(repoRoot, 'packaging', 'installer.nsi'),
  ]);
  if (!existsSync(installerOut)) throw new Error('安装包没有生成');
  log(`安装包：${installerOut}（${(statSync(installerOut).size / 1024 / 1024).toFixed(1)}MB）`);

  rmSync(stageDir, { recursive: true, force: true });
  // 只留最终产物，别把中间目录堆在 dist 里
  const leftovers = readdirSync(distDir).filter((n) => n.endsWith('-stage'));
  for (const l of leftovers) rmSync(join(distDir, l), { recursive: true, force: true });
}

main();
