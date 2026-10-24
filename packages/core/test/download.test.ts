import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, statSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildFfmpegArgs,
  checkMediaTools,
  downloadWithFfmpeg,
  partPathFor,
  probeFile,
  stalePathFor,
  verifyMedia,
} from '../src/index.js';

const hasFfmpeg = ((): boolean => {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    execFileSync('ffprobe', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const ff = (...args: string[]): void => {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: 'inherit' });
};

describe('ffmpeg 参数与路径', () => {
  it('转封装参数带 crypto 协议白名单与 -allowed_extensions ALL（AES-128 分片必需）', () => {
    const args = buildFfmpegArgs({ manifestPath: 'a.m3u8', outPath: 'b.mp4' });
    expect(args).toContain('-protocol_whitelist');
    expect(args[args.indexOf('-protocol_whitelist') + 1]).toBe('file,http,https,tcp,tls,crypto');
    expect(args[args.indexOf('-allowed_extensions') + 1]).toBe('ALL');
    expect(args[args.indexOf('-c') + 1]).toBe('copy'); // 绝不重编码
    expect(args).toContain('-progress');
    expect(args).toContain('-nostats');
  });

  it('残件命名：.part / .retryN / .part.stale-<ts>', () => {
    const target = 'D:/out/视频名.mp4';
    expect(partPathFor(target, 1, 'mp4')).toBe('D:/out/视频名.part.mp4');
    expect(partPathFor(target, 2, 'mp4')).toBe('D:/out/视频名.retry2.mp4');
    expect(stalePathFor(target, 'mp4', 1234)).toBe('D:/out/视频名.part.stale-1234.mp4');
    expect(partPathFor('D:/out/a.mkv', 1, 'mkv')).toBe('D:/out/a.part.mkv');
  });
});

describe.skipIf(!hasFfmpeg)('真实 ffmpeg：下载与核验', () => {
  let dir = '';
  let plainMp4 = '';
  let encryptedManifest = '';

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'acfun-ff-'));
    plainMp4 = join(dir, 'plain.mp4');
    // 3 秒 30fps 测试源（≈90 帧）
    ff(
      '-f',
      'lavfi',
      '-i',
      'testsrc=size=320x240:rate=30:duration=3',
      '-pix_fmt',
      'yuv420p',
      '-c:v',
      'libx264',
      '-g',
      '30',
      plainMp4,
    );

    // 造一份 AES-128 加密的 HLS（与站点形态一致：#EXT-X-KEY + 带 key 的分片）
    const keyPath = join(dir, 'enc.key');
    writeFileSync(keyPath, Buffer.from('0123456789abcdef', 'utf8'));
    const keyInfo = join(dir, 'key_info.txt');
    // 第一行 key URI，第二行本地 key 文件；分片用相对路径
    writeFileSync(keyInfo, `enc.key\n${keyPath}\n`, 'utf8');
    encryptedManifest = join(dir, 'index.m3u8');
    ff(
      '-f',
      'lavfi',
      '-i',
      'testsrc=size=320x240:rate=30:duration=3',
      '-pix_fmt',
      'yuv420p',
      '-c:v',
      'libx264',
      '-g',
      '30',
      '-f',
      'hls',
      '-hls_time',
      '1',
      '-hls_list_size',
      '0',
      '-hls_key_info_file',
      keyInfo,
      '-hls_segment_filename',
      join(dir, 'seg%d.ts'),
      encryptedManifest,
    );
  });

  afterAll(() => {
    /* 临时目录交给系统清理 */
  });

  it('checkMediaTools 能读出 ffmpeg/ffprobe 版本', async () => {
    const tools = await checkMediaTools();
    expect(tools.ffmpegVersion).toContain('ffmpeg version');
    expect(tools.ffprobeVersion).toContain('ffprobe version');
  });

  it('干净的 mp4 通过核验', async () => {
    const v = await verifyMedia({ path: plainMp4, manifestDurationSec: 3 });
    expect(v.ok).toBe(true);
    expect(v.frames).toBeGreaterThan(80);
    expect(v.fileSize).toBeGreaterThan(0);
  });

  it('人为截断的 .part 被核验拒绝交付', async () => {
    const broken = join(dir, 'broken.part.mp4');
    copyFileSync(plainMp4, broken);
    const size = statSync(broken).size;
    truncateSync(broken, Math.floor(size * 0.35)); // 丢掉尾部 moov / 大量数据
    const v = await verifyMedia({ path: broken, manifestDurationSec: 3 });
    expect(v.ok).toBe(false);
    expect(v.reason).toBeTruthy();
  });

  it('时长与清单不符（差太多）被拒绝', async () => {
    const v = await verifyMedia({ path: plainMp4, manifestDurationSec: 60 });
    expect(v.ok).toBe(false);
    expect(v.reason).toContain('不符');
  });

  it('0 字节产物视为失败', async () => {
    const empty = join(dir, 'empty.mp4');
    writeFileSync(empty, '');
    const v = await verifyMedia({ path: empty, manifestDurationSec: 3 });
    expect(v.ok).toBe(false);
    expect(v.reason).toContain('0 字节');
  });

  it('AES-128 加密 HLS 能 -c copy 转封装并核验通过（crypto 白名单生效）', async () => {
    const manifestText = readFileSync(encryptedManifest, 'utf8');
    expect(manifestText).toContain('#EXT-X-KEY:METHOD=AES-128');

    const out = join(dir, 'from-hls.mp4');
    const progress: number[] = [];
    const dl = await downloadWithFfmpeg({
      manifestPath: encryptedManifest,
      outPath: out,
      manifestDurationSec: 3,
      onProgress: (p) => progress.push(p.percent),
    });
    expect(dl.code).toBe(0);
    expect(progress.length).toBeGreaterThan(0);

    const info = await probeFile(out);
    expect(info.frames).toBeGreaterThan(80);
    const v = await verifyMedia({ path: out, manifestDurationSec: 3 });
    expect(v.ok).toBe(true);
  });
});
