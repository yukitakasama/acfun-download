/**
 * 下载、进度与核验（PLAN §6.3）。
 *
 * 铁律：**核验不可关闭**。ffmpeg 丢了分片照样 exit 0、照样打印「完成」
 * （实测 `Error in the pull function` / `-10054` / `Packet corrupt` 后跳坏段继续跑），
 * 只看退出码会把坏片当成品交付。所以：
 *   1. `ffmpeg -v error -i part -f null -` 必须**无任何输出**；
 *   2. `ffprobe -count_frames` 的时长要与清单 `#EXTINF` 累加值对齐（±max(1.5s, 2%)）；
 *   3. 帧数 ≥ 0.985 × 时长 × fps（防「时长够但中间丢段」）。
 * 三条全过才允许 rename 成交付名。
 */
import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { AppError } from '../errors.js';
import type { ContainerFormat } from '../types.js';
import { runProcess } from '../browser/spawn.js';

export interface FfmpegArgsInput {
  manifestPath: string;
  outPath: string;
}

/** 统一的 ffmpeg 转封装参数（`-c copy`，绝不重编码）。 */
export function buildFfmpegArgs(input: FfmpegArgsInput): string[] {
  return [
    '-hide_banner',
    '-loglevel',
    'warning',
    '-y',
    // AES-128 加密分片必需：crypto 协议 + 允许所有扩展名
    '-protocol_whitelist',
    'file,http,https,tcp,tls,crypto',
    '-allowed_extensions',
    'ALL',
    '-i',
    input.manifestPath,
    '-c',
    'copy',
    '-progress',
    'pipe:1',
    '-nostats',
    input.outPath,
  ];
}

export interface DownloadProgress {
  /** ffmpeg 报告的已处理时长（秒）。 */
  timeSec: number;
  /** 相对清单总时长的百分比（0–100，封顶 100）。 */
  percent: number;
  speed?: string;
  bytes?: number;
}

export interface DownloadOptions {
  manifestPath: string;
  outPath: string;
  /** 清单累加时长，用于算进度百分比。 */
  manifestDurationSec: number;
  ffmpegPath?: string;
  onProgress?: (p: DownloadProgress) => void;
  signal?: AbortSignal;
  /** 进度合并窗口（毫秒），默认 500ms（PLAN：SSE/进度每 ≤500ms 一次）。 */
  progressIntervalMs?: number;
}

export interface DownloadOutcome {
  code: number | null;
  stderr: string;
  aborted: boolean;
  /** ffmpeg 最后报告的时长（秒），供进度条收尾用。 */
  lastTimeSec: number;
}

/** 跑 ffmpeg 转封装，边跑边解析 `-progress pipe:1` 的 `out_time_us`。 */
export function downloadWithFfmpeg(opts: DownloadOptions): Promise<DownloadOutcome> {
  return new Promise<DownloadOutcome>((resolve) => {
    const args = buildFfmpegArgs({ manifestPath: opts.manifestPath, outPath: opts.outPath });
    const child = spawn(opts.ffmpegPath ?? 'ffmpeg', args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });

    const errChunks: string[] = [];
    let lastTimeSec = 0;
    let lastEmit = 0;
    let aborted = false;

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      errChunks.push(chunk);
      if (errChunks.length > 400) errChunks.shift();
    });

    const rl = createInterface({ input: child.stdout });
    rl.on('line', (line: string) => {
      const eq = line.indexOf('=');
      if (eq < 0) return;
      const key = line.slice(0, eq).trim();
      const value = line.slice(eq + 1).trim();
      if (key === 'out_time_us' || key === 'out_time_ms') {
        const us = Number.parseInt(value, 10);
        if (Number.isFinite(us) && us >= 0) lastTimeSec = us / 1_000_000;
      } else if (key === 'total_size') {
        // 仅记录，进度主要由时长驱动
      }
      if (key === 'progress') {
        const now = Date.now();
        const interval = opts.progressIntervalMs ?? 500;
        if (now - lastEmit >= interval || value === 'end') {
          lastEmit = now;
          const total = opts.manifestDurationSec > 0 ? opts.manifestDurationSec : 0;
          const percent = total > 0 ? Math.min(100, Math.max(0, (lastTimeSec / total) * 100)) : 0;
          opts.onProgress?.({ timeSec: lastTimeSec, percent });
        }
      }
    });

    const onAbort = (): void => {
      aborted = true;
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    child.on('error', (e) => {
      opts.signal?.removeEventListener('abort', onAbort);
      resolve({ code: null, stderr: `${errChunks.join('')}${e.message}`, aborted, lastTimeSec });
    });

    child.on('close', (code) => {
      opts.signal?.removeEventListener('abort', onAbort);
      rl.close();
      resolve({ code, stderr: errChunks.join(''), aborted, lastTimeSec });
    });
  });
}

export interface FfprobeInfo {
  frames: number;
  durationSec: number;
  fps: number;
  width?: number;
  height?: number;
  codec?: string;
}

/** 读视频流帧数与时长（`-count_frames` 会真解码，慢但准）。 */
export async function probeFile(path: string, ffprobePath = 'ffprobe'): Promise<FfprobeInfo> {
  const r = await runProcess(
    ffprobePath,
    [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-count_frames',
      '-show_entries',
      'stream=nb_read_frames,avg_frame_rate,width,height,codec_name:format=duration',
      '-of',
      'default=noprint_wrappers=1',
      path,
    ],
    { timeoutMs: 30 * 60_000 },
  );
  const out = r.stdout;
  const frames = Number.parseInt(/nb_read_frames=(\d+)/.exec(out)?.[1] ?? '0', 10);
  // format=duration 与 stream 的 duration 都可能出现，取第一个有效的
  const durMatches = [...out.matchAll(/duration=([\d.]+)/g)].map((m) => Number.parseFloat(m[1] ?? ''));
  const durationSec = durMatches.find((d) => Number.isFinite(d) && d > 0) ?? 0;
  const fpsMatch = /avg_frame_rate=(\d+)\/(\d+)/.exec(out);
  const fps = fpsMatch && Number(fpsMatch[2]) > 0 ? Number(fpsMatch[1]) / Number(fpsMatch[2]) : 0;
  const width = Number.parseInt(/width=(\d+)/.exec(out)?.[1] ?? '', 10);
  const height = Number.parseInt(/height=(\d+)/.exec(out)?.[1] ?? '', 10);
  const codec = /codec_name=(\w+)/.exec(out)?.[1];
  return {
    frames: Number.isFinite(frames) ? frames : 0,
    durationSec,
    fps,
    ...(Number.isFinite(width) ? { width } : {}),
    ...(Number.isFinite(height) ? { height } : {}),
    ...(codec ? { codec } : {}),
  };
}

export interface VerifyOptions {
  path: string;
  /** 清单 `#EXTINF` 累加时长。 */
  manifestDurationSec: number;
  ffmpegPath?: string;
  ffprobePath?: string;
  /** 时长容差：max(1.5s, 2%)。 */
  durationToleranceSec?: number;
}

export interface VerifyResult {
  ok: boolean;
  reason?: string;
  frames: number;
  durationSec: number;
  fileSize: number;
}

/** 全量解码核验（不可跳过）。 */
export async function verifyMedia(opts: VerifyOptions): Promise<VerifyResult> {
  let fileSize = 0;
  try {
    fileSize = statSync(opts.path).size;
  } catch {
    return { ok: false, reason: '产物文件不存在', frames: 0, durationSec: 0, fileSize: 0 };
  }
  if (fileSize === 0) {
    return { ok: false, reason: '产物大小为 0 字节（视为失败）', frames: 0, durationSec: 0, fileSize };
  }

  // 1) 全量解码：必须无任何输出
  const decode = await runProcess(opts.ffmpegPath ?? 'ffmpeg', ['-v', 'error', '-i', opts.path, '-f', 'null', '-'], {
    timeoutMs: 60 * 60_000,
  });
  const decodeOut = `${decode.stderr}${decode.stdout}`.trim();
  if (decode.code !== 0 || decodeOut) {
    const head = decodeOut.split(/\r?\n/).slice(0, 3).join(' | ');
    return {
      ok: false,
      reason: `解码报错: ${head || `ffmpeg 退出码 ${decode.code}`}`,
      frames: 0,
      durationSec: 0,
      fileSize,
    };
  }

  // 2) 帧数 / 时长比对清单
  const info = await probeFile(opts.path, opts.ffprobePath ?? 'ffprobe');
  if (!info.frames || !info.durationSec) {
    return { ok: false, reason: 'ffprobe 未能读出帧数/时长', frames: info.frames, durationSec: info.durationSec, fileSize };
  }
  const manifest = opts.manifestDurationSec;
  if (manifest > 0) {
    const tolerance = opts.durationToleranceSec ?? Math.max(1.5, manifest * 0.02);
    if (Math.abs(info.durationSec - manifest) > tolerance) {
      return {
        ok: false,
        reason: `时长 ${info.durationSec.toFixed(1)}s 与清单 ${manifest.toFixed(1)}s 不符（疑似丢分片）`,
        frames: info.frames,
        durationSec: info.durationSec,
        fileSize,
      };
    }
    const fps = info.fps > 0 ? info.fps : 30;
    const expected = info.durationSec * fps;
    if (info.frames < expected * 0.985) {
      return {
        ok: false,
        reason: `帧数 ${info.frames} 低于预期 ${Math.round(expected)}（疑似丢分片）`,
        frames: info.frames,
        durationSec: info.durationSec,
        fileSize,
      };
    }
  }
  return { ok: true, frames: info.frames, durationSec: info.durationSec, fileSize };
}

export interface ToolCheck {
  ffmpeg: string;
  ffprobe: string;
  ffmpegVersion: string;
  ffprobeVersion: string;
}

/**
 * 前置检查：ffmpeg / ffprobe 必须可用（计划：不内嵌，启动即查）。
 * 找不到 → FFMPEG_MISSING（带「装哪里 / 怎么配」的建议）。
 */
export async function checkMediaTools(ffmpegPath = 'ffmpeg', ffprobePath = 'ffprobe'): Promise<ToolCheck> {
  const [f, p] = await Promise.all([
    runProcess(ffmpegPath, ['-version'], { timeoutMs: 15_000 }),
    runProcess(ffprobePath, ['-version'], { timeoutMs: 15_000 }),
  ]);
  const ffmpegFirst = f.stdout.split(/\r?\n/)[0]?.trim() ?? '';
  const ffprobeFirst = p.stdout.split(/\r?\n/)[0]?.trim() ?? '';
  if (f.code !== 0 || !ffmpegFirst) {
    throw new AppError('FFMPEG_MISSING', `找不到可用的 ffmpeg（${ffmpegPath}）`, {
      detail: f.stderr.slice(0, 300),
    });
  }
  if (p.code !== 0 || !ffprobeFirst) {
    throw new AppError('FFMPEG_MISSING', `找不到可用的 ffprobe（${ffprobePath}）`, {
      detail: p.stderr.slice(0, 300),
    });
  }
  return { ffmpeg: ffmpegPath, ffprobe: ffprobePath, ffmpegVersion: ffmpegFirst, ffprobeVersion: ffprobeFirst };
}

/** 临时残件命名：`<目标>.part.<ext>` / 重试轮 `<目标>.retry.<ext>` / 过期残留 `<目标>.part.stale-<ts>`。 */
export function partPathFor(targetPath: string, attempt: number, container: ContainerFormat): string {
  const base = targetPath.replace(new RegExp(`\\.${container}$`), '');
  return attempt <= 1 ? `${base}.part.${container}` : `${base}.retry${attempt}.${container}`;
}

/** 过期的旧残件改名保留（不覆盖、不删除用户数据）。 */
export function stalePathFor(targetPath: string, container: ContainerFormat, ts = Date.now()): string {
  const base = targetPath.replace(new RegExp(`\\.${container}$`), '');
  return `${base}.part.stale-${ts}.${container}`;
}
