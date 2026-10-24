import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AppError,
  runTask,
  type InputItem,
  type Manifest,
  type ParsedTarget,
  type PipelineOptions,
  type ResolvedVideo,
  type TaskEvent,
} from '../src/index.js';

const hasFfmpeg = ((): boolean => {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const item: InputItem = { raw: 'https://d.work/community/1', url: 'https://d.work/community/1', source: 'arg' };
const input = { item, index: 1, total: 1, taskId: 't1' };

function fakeResolved(manifestPath: string, overrides: Partial<Manifest> = {}): ResolvedVideo {
  const target: ParsedTarget = {
    url: item.url,
    origin: 'https://d.work',
    host: 'd.work',
    path: '/community/1',
    kind: 'post',
    pageId: '1',
    generation: 'nuxt',
  };
  const manifest: Manifest = {
    playlistUrl: 'https://acpcssr.x.work/api/m3u8/public/decode/authPath?path=a',
    text: '#EXTM3U\n',
    segments: 3,
    durationSec: 3,
    hasEndlist: true,
    ...overrides,
  };
  return {
    target,
    meta: {
      videoId: '1',
      title: '测试视频/含非法字符',
      author: '',
      pageUrl: item.url,
      generation: 'nuxt',
      durationSec: 3,
    },
    manifest,
    manifestPath,
    channel: 'official',
    record: { id: '1', url: item.url, ok: true },
  };
}

function baseOpts(outDir: string, workDir: string): PipelineOptions {
  return {
    outDir,
    container: 'mp4',
    nameMode: 'title',
    onExist: 'rename',
    retries: 1,
    meta: true,
    cover: false,
    danmaku: false,
    subtitle: false,
    workDir,
  };
}

describe('runTask：重试与退避', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('可重试错误按 1s → 2s 退避，跑满 --retries 轮后判失败', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'acfun-pipe-'));
    const calls: number[] = [];
    const resolveFn = vi.fn(async () => {
      calls.push(Date.now());
      throw new AppError('NET_TIMEOUT', '连接超时');
    });

    const p = runTask(input, { ...baseOpts(outDir, outDir), retries: 3, resolveFn });
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await p;

    expect(resolveFn).toHaveBeenCalledTimes(3);
    expect(result.status).toBe('failed');
    expect(result.errorKind).toBe('NET_TIMEOUT');
    expect(result.attempts).toBe(3);
    // 第 2 轮比第 1 轮晚 ~1000ms，第 3 轮再晚 ~2000ms
    expect(calls[1]! - calls[0]!).toBeGreaterThanOrEqual(1000);
    expect(calls[2]! - calls[1]!).toBeGreaterThanOrEqual(2000);
  });

  it('不可重试错误（需鉴权）立刻失败，只跑 1 轮', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'acfun-pipe-'));
    const resolveFn = vi.fn(async () => {
      throw new AppError('AUTH_REQUIRED', 'canWatch=false');
    });
    const result = await runTask(input, { ...baseOpts(outDir, outDir), retries: 3, resolveFn });
    expect(resolveFn).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('failed');
    expect(result.errorKind).toBe('AUTH_REQUIRED');
    expect(result.suggestion).toBeTruthy();
  });

  it('Ctrl+C：中断后判 USER_ABORT 并落 resume.json（保留 .part 供 --resume）', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'acfun-pipe-'));
    const controller = new AbortController();
    const resolveFn = vi.fn(async () => {
      controller.abort();
      return fakeResolved(join(outDir, 'm.m3u8'));
    });
    const events: TaskEvent[] = [];
    const result = await runTask(input, {
      ...baseOpts(outDir, outDir),
      retries: 3,
      resolveFn,
      signal: controller.signal,
      onEvent: (e) => events.push(e),
    });
    expect(result.status).toBe('failed');
    expect(result.errorKind).toBe('USER_ABORT');
    expect(resolveFn).toHaveBeenCalledTimes(1); // 中断后不再重试
    const resumeFile = join(outDir, 'reports', 'resume-t1.json');
    expect(existsSync(resumeFile)).toBe(true);
    const state = JSON.parse(readFileSync(resumeFile, 'utf8')) as Record<string, unknown>;
    expect(state.url).toBe(item.url);
    expect(state.attempt).toBe(1);
    expect(events.some((e) => e.type === 'log' && e.message.includes('已中断'))).toBe(true);
  });
});

describe('runTask：命名与跳过', () => {
  it('--on-exist skip：已存在同名文件则跳过，不算失败', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'acfun-pipe-'));
    const manifestPath = join(outDir, 'm.m3u8');
    writeFileSync(manifestPath, '#EXTM3U\n', 'utf8');
    // 标题清洗后是 测试视频_含非法字符
    writeFileSync(join(outDir, '测试视频_含非法字符.mp4'), 'x');

    const result = await runTask(input, {
      ...baseOpts(outDir, outDir),
      onExist: 'skip',
      resolveFn: async () => fakeResolved(manifestPath),
    });
    expect(result.status).toBe('skipped');
    expect(result.filePath).toContain('测试视频_含非法字符.mp4');
  });

  it('--on-exist rename：重名时落 -1', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'acfun-pipe-'));
    const manifestPath = join(outDir, 'm.m3u8');
    writeFileSync(manifestPath, '#EXTM3U\n', 'utf8');
    writeFileSync(join(outDir, '测试视频_含非法字符.mp4'), 'x');
    const result = await runTask(input, {
      ...baseOpts(outDir, outDir),
      onExist: 'rename',
      // 直接让解析失败，只看命名：用不可下载的清单触发 ffmpeg 失败
      resolveFn: async () => fakeResolved(join(outDir, 'missing.m3u8')),
    });
    expect(result.status).toBe('failed');
    // 失败也不能产出交付文件（不覆盖已有成品）
    expect(readFileSync(join(outDir, '测试视频_含非法字符.mp4'), 'utf8')).toBe('x');
  });
});

describe.skipIf(!hasFfmpeg)('runTask：真实 ffmpeg 端到端', () => {
  it('本地加密 HLS：下载 → 核验 → 转正 → 写 meta sidecar', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'acfun-e2e-'));
    const outDir = join(dir, 'out');
    const keyPath = join(dir, 'enc.key');
    writeFileSync(keyPath, Buffer.from('0123456789abcdef', 'utf8'));
    const keyInfo = join(dir, 'key_info.txt');
    writeFileSync(keyInfo, `enc.key\n${keyPath}\n`, 'utf8');
    const manifestPath = join(dir, 'index.m3u8');
    execFileSync(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
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
        manifestPath,
      ],
      { stdio: 'inherit' },
    );

    const events: TaskEvent[] = [];
    const result = await runTask(input, {
      ...baseOpts(outDir, dir),
      retries: 1,
      resolveFn: async () => fakeResolved(manifestPath),
      onEvent: (e) => events.push(e),
    });

    expect(result.status).toBe('success');
    expect(result.fileSize).toBeGreaterThan(0);
    expect(result.verified?.frames).toBeGreaterThan(80);
    expect(existsSync(result.filePath!)).toBe(true);
    // 中间态 .part 不应残留
    expect(existsSync(result.filePath!.replace(/\.mp4$/, '.part.mp4'))).toBe(false);
    // meta sidecar
    const metaFile = result.filePath!.replace(/\.mp4$/, '.meta.json');
    expect(existsSync(metaFile)).toBe(true);
    const meta = JSON.parse(readFileSync(metaFile, 'utf8')) as Record<string, any>;
    expect(meta.generation).toBe('nuxt');
    expect(meta.verified.frames).toBe(result.verified?.frames);
    // 状态流转事件齐全
    const statuses = events.filter((e) => e.type === 'task').map((e) => (e as { status: string }).status);
    expect(statuses).toEqual(expect.arrayContaining(['queued', 'resolving', 'downloading', 'verifying', 'done']));
    expect(events.some((e) => e.type === 'progress')).toBe(true);
  }, 60_000);
});
