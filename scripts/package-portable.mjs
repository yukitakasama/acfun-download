/**
 * 打包「便携版」：dist/AcFun下载-<version>-portable.zip
 *
 * 解压即用，不写注册表、不建快捷方式、不需要安装 Node。
 * 内容与安装包一致（同一个 stage 函数）。
 */
import { existsSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { buildAll, distDir, log, run, stage, version } from './package-shared.mjs';

const stageDir = join(distDir, 'portable-stage');
const zipOut = join(distDir, `AcFun下载-${version}-portable.zip`);

function main() {
  if (process.platform !== 'win32') throw new Error('仅支持 Windows x64 打包');

  buildAll();

  log('3/3 打 zip');
  stage(stageDir);
  rmSync(zipOut, { force: true });
  run('powershell.exe', [
    '-NoProfile',
    '-Command',
    `Compress-Archive -Path '${stageDir.replaceAll("'", "''")}\\*' -DestinationPath '${zipOut.replaceAll("'", "''")}' -CompressionLevel Optimal -Force`,
  ]);
  if (!existsSync(zipOut)) throw new Error('zip 没有生成');
  log(`便携版：${zipOut}（${(statSync(zipOut).size / 1024 / 1024).toFixed(1)}MB）`);
  rmSync(stageDir, { recursive: true, force: true });
}

main();
