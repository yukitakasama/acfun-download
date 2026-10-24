import { execFileSync } from 'node:child_process';
import { createReadStream, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { downloadWithFfmpeg, ProgressTracker, parseProgressLine, parseSpeedX, scrubSecrets } from '../src/index.js';
import { tmpDir } from './helpers/tmp.js';

const hasFfmpeg = ((): boolean => {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

describe('进度解析小工具', () => {
  it('parseProgressLine 拆 key=value', () => {
    expect(parseProgressLine('out_time_us=1234567')).toEqual({ key: 'out_time_us', value: '1234567' });
    expect(parseProgressLine('progress=continue')).toEqual({ key: 'progress', value: 'continue' });
    expect(parseProgressLine('没有等号')).toBeNull();
  });

  it('parseSpeedX 只认 12.3x，不认 N/A', () => {
    expect(parseSpeedX('12.3x')).toBe(12.3);
    expect(parseSpeedX('1.0x')).toBe(1);
    expect(parseSpeedX('N/A')).toBeUndefined();
    expect(parseSpeedX(undefined)).toBeUndefined();
  });

  it('scrubSecrets 抹掉 auth_key / token', () => {
    const s = scrubSecrets("Opening 'https://x/a.ts?auth_key=1759-abc-10-dead' for reading token=secret");
    expect(s).not.toContain('1759-abc');
    expect(s).not.toContain('secret');
    expect(s).toContain('auth_key=***');
  });
});

describe('ProgressTracker：段级进度', () => {
  it('用 Opening 行统计已下载分片（排除 m3u8 与 key）', () => {
    const t = new ProgressTracker({ manifestDurationSec: 40, segTotal: 10 });
    for (let i = 0; i < 5; i++) t.feedStderrLine(`[hls @ 0x1] Opening 'https://x/s${i}.ts?auth_key=k' for reading`);
    // 这些不该被计入
    t.feedStderrLine(`[hls @ 0x1] Opening 'https://x/index.m3u8' for reading`);
    t.feedStderrLine(`[hls @ 0x1] Opening 'https://x/key/enc.key?auth_key=k' for reading`);

    const p = t.snapshot();
    expect(p.segDone).toBe(5);
    expect(p.segTotal).toBe(10);
    expect(p.percent).toBe(50); // 5/10 段 > 时间进度(0)
  });

  it('同一分片重复出现只算一次', () => {
    const t = new ProgressTracker({ manifestDurationSec: 40, segTotal: 4 });
    for (let i = 0; i < 3; i++) t.feedStderrLine(`Opening 'https://x/s0.ts' for reading`);
    expect(t.snapshot().segDone).toBe(1);
  });

  it('段级与时间级取较大者', () => {
    const t = new ProgressTracker({ manifestDurationSec: 100, segTotal: 100 });
    t.feedStdoutLine('out_time_us=50000000'); // 50s / 100s = 50%
    t.feedStdoutLine('progress=continue');
    const p1 = t.snapshot();
    expect(p1.percent).toBe(50);
  });
});

describe('ProgressTracker：不会「假满格」', () => {
  it('运行期封顶 99.5（即使 out_time 已到/超过总时长）', () => {
    const t = new ProgressTracker({ manifestDurationSec: 60 });
    t.feedStdoutLine('out_time_us=60000000');
    t.feedStdoutLine('progress=continue');
    expect(t.snapshot().percent).toBe(99.5);
    // ffmpeg 正常退出后才 100
    expect(t.finish().percent).toBe(100);
  });

  it('百分比单调不减（时间戳回跳也不会倒退）', () => {
    const t = new ProgressTracker({ manifestDurationSec: 100 });
    t.feedStdoutLine('out_time_us=50000000');
    expect(t.snapshot().percent).toBe(50);
    t.feedStdoutLine('out_time_us=10000000'); // 回跳
    expect(t.snapshot().percent).toBe(50);
  });

  it('清单没有分片/时长为 0 时不会出现 NaN', () => {
    const t = new ProgressTracker({ manifestDurationSec: 0 });
    t.feedStdoutLine('out_time_us=123456');
    const p = t.snapshot();
    expect(Number.isFinite(p.percent)).toBe(true);
    expect(p.percent).toBe(0);
  });

  it('N/A 与非法数值被忽略', () => {
    const t = new ProgressTracker({ manifestDurationSec: 10 });
    t.feedStdoutLine('out_time_us=N/A');
    t.feedStdoutLine('total_size=N/A');
    t.feedStdoutLine('speed=N/A');
    const p = t.snapshot();
    expect(p.percent).toBe(0);
    expect(p.bytes).toBeUndefined();
    expect(p.speedX).toBeUndefined();
  });
});

describe('ProgressTracker：速度 / 卡住检测', () => {
  it('从 total_size 增量算速度（EMA）', () => {
    let now = 1_000_000;
    const t = new ProgressTracker({ manifestDurationSec: 100, now: () => now });
    t.feedStdoutLine('total_size=1048576');
    now += 1000;
    t.feedStdoutLine('total_size=2097152'); // +1MB/s
    const p = t.snapshot();
    expect(p.bytes).toBe(2097152);
    expect(p.bytesPerSec).toBeGreaterThan(500_000);
    expect(p.bytesPerSec).toBeLessThanOrEqual(1_048_576 + 1);
  });

  it('speed 头透传', () => {
    const t = new ProgressTracker({ manifestDurationSec: 100 });
    t.feedStdoutLine('speed=12.3x');
    expect(t.snapshot().speedX).toBe(12.3);
  });

  it('5 秒没有新数据 → stalled，且不再给速度（避免显示假速度）', () => {
    let now = 1_000_000;
    const t = new ProgressTracker({ manifestDurationSec: 100, now: () => now });
    t.feedStdoutLine('total_size=1048576');
    now += 500;
    t.feedStdoutLine('total_size=2097152');
    expect(t.snapshot().bytesPerSec).toBeGreaterThan(0);
    now += 6000;
    const p = t.snapshot();
    expect(p.stalled).toBe(true);
    expect(p.bytesPerSec).toBeUndefined();
  });

  it('total_size=N/A 时用输出文件实际大小算字节与速度（mp4 常见）', () => {
    const dir = tmpDir('acfun-prog-');
    const file = join(dir, 'part.mp4');
    writeFileSync(file, Buffer.alloc(1000));
    let now = 1_000_000;
    const t = new ProgressTracker({ manifestDurationSec: 100, outPath: file, now: () => now });
    t.feedStdoutLine('total_size=N/A');
    t.feedStdoutLine('progress=continue'); // 基线：1000B
    writeFileSync(file, Buffer.alloc(3000));
    now += 1000;
    t.feedStdoutLine('progress=continue');
    const p = t.snapshot();
    expect(p.bytes).toBe(3000);
    expect(p.bytesPerSec).toBeGreaterThan(1500);
  });

  it('eta 在有一定耗时后才给', () => {
    let now = 1_000_000;
    const t = new ProgressTracker({ manifestDurationSec: 100, now: () => now });
    now += 1000;
    t.feedStdoutLine('out_time_us=10000000');
    expect(t.snapshot().etaSec).toBeUndefined(); // 还不到 2s，样本太少
    now += 3000;
    const p = t.snapshot();
    expect(p.etaSec).toBeGreaterThan(0);
  });
});

describe.skipIf(!hasFfmpeg)('downloadWithFfmpeg：真实 ffmpeg + 限速本地 HTTP', () => {
  let server: Server | null = null;

  afterAll(() => {
    server?.close();
  });

  it('多段 HLS 通过本地 HTTP 慢速提供 → 进度多次推送、段数递增、最终 100%', async () => {
    const dir = tmpDir('acfun-prog-');
    // 生成 20s / 5 段左右的 HLS
    execFileSync(
      'ffmpeg',
      [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=30:duration=30',
        '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-g', '30',
        '-f', 'hls', '-hls_time', '1', '-hls_list_size', '0',
        '-hls_segment_filename', join(dir, 'seg%d.ts'),
        join(dir, 'origin.m3u8'),
      ],
      { stdio: 'inherit' },
    );

    const segFiles = Array.from({ length: 60 }, (_, i) => `seg${i}.ts`).filter((f) => existsSync(join(dir, f)));
    expect(segFiles.length).toBeGreaterThan(1);

    // 起一个每段延迟 150ms 的本地 HTTP 服务（模拟真实网络节奏）
    server = createServer((req, res) => {
      const name = decodeURIComponent((req.url ?? '/').split('?')[0]!.replace(/^\//, ''));
      const file = join(dir, name);
      if (!existsSync(file)) {
        res.statusCode = 404;
        res.end('nope');
        return;
      }
      setTimeout(() => {
        res.setHeader('content-type', name.endsWith('.ts') ? 'video/mp2t' : 'application/vnd.apple.mpegurl');
        createReadStream(file).pipe(res);
      }, name.endsWith('.ts') ? 90 : 0);
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    const base = `http://127.0.0.1:${port}`;

    // 把清单里的分片改成绝对 URL 指向本地服务
    const playlist = readFileSync(join(dir, 'origin.m3u8'), 'utf8')
      .split(/\r?\n/)
      .map((line) => (line && !line.startsWith('#') ? `${base}/${line.trim()}` : line))
      .join('\n');
    const manifestPath = join(dir, 'playlist.m3u8');
    writeFileSync(manifestPath, playlist, 'utf8');

    const manifestDur = playlist
      .split(/\r?\n/)
      .reduce((a, l) => {
        const m = /^#EXTINF:([\d.]+)/.exec(l.trim());
        return a + (m?.[1] ? Number.parseFloat(m[1]) : 0);
      }, 0);

    const samples: Array<{ pct: number; segDone?: number; segTotal?: number; bps?: number; bytes?: number }> = [];
    const outcome = await downloadWithFfmpeg({
      manifestPath,
      outPath: join(dir, 'out.mp4'),
      manifestDurationSec: manifestDur,
      segTotal: segFiles.length,
      progressIntervalMs: 0, // 测试里不节流，保证能观测到中间态
      onProgress: (p) =>
        samples.push({ pct: p.percent, segDone: p.segDone, segTotal: p.segTotal, bps: p.bytesPerSec, bytes: p.bytes }),
    });

    expect(outcome.code).toBe(0);
    expect(samples.length).toBeGreaterThanOrEqual(3);

    // 中间态必须出现过（不是「一上来就满格」）
    const mids = samples.filter((s) => s.pct > 0 && s.pct < 99.5);
    expect(mids.length).toBeGreaterThan(0);

    // 段级进度递增，且最终等于总段数
    const segSeries = samples.map((s) => s.segDone ?? 0);
    for (let i = 1; i < segSeries.length; i++) expect(segSeries[i]!).toBeGreaterThanOrEqual(segSeries[i - 1]!);
    expect(Math.max(...segSeries)).toBe(segFiles.length);
    expect(samples.every((s) => s.segTotal === segFiles.length)).toBe(true);

    // 百分比单调不减，最后一条是 100
    for (let i = 1; i < samples.length; i++) expect(samples[i]!.pct).toBeGreaterThanOrEqual(samples[i - 1]!.pct);
    expect(samples.at(-1)?.pct).toBe(100);
    expect(samples.filter((s) => s.pct > 99.5)).toHaveLength(1); // 只有收尾那条是 100

    // 有速度/字节数据
    expect(samples.some((s) => (s.bps ?? 0) > 0)).toBe(true);
    expect(samples.at(-1)?.bytes).toBeGreaterThan(0);
  }, 120_000);
});
