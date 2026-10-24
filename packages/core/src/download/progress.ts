/**
 * 下载进度追踪（被 download/index.ts 使用，纯逻辑，方便单测）。
 *
 * 为什么不能只看 ffmpeg 的 out_time：
 *   - 网络比播放快时，`out_time` 很快追到媒体总时长 → 进度条一上来就「满格」，
 *     但 ffmpeg 其实还在下载尾部分片/收尾（用户看到流量在动、界面却不动）。
 *   - `-c copy` 不做转码，`out_time` 反映的是「已写入的媒体时间」，不是「已下载的数据量」。
 *
 * 所以进度取两个来源的较大值：
 *   1) 段级：从 ffmpeg stderr 的 `Opening '<url>' for reading` 统计已打开的分片数 / 清单段数
 *      （这是最贴近「下载」的指标，且与分片命名无关）
 *   2) 时间：`out_time_us / 清单累加时长`
 * 运行期百分比封顶 99.5，只有 ffmpeg 正常退出后才由上层置 100 —— 避免「假完成」。
 */
import { statSync } from 'node:fs';

export interface DownloadProgress {
  /** 0–100（运行期 ≤ 99.5）。 */
  percent: number;
  /** 已写入的媒体时间（秒）。 */
  timeSec: number;
  /** 已写入字节（ffmpeg total_size，mp4 为近似最终大小）。 */
  bytes?: number;
  /** 瞬时下载速度（字节/秒，EMA 平滑）。 */
  bytesPerSec?: number;
  /** ffmpeg 报告的倍速（如 12.3 表示 12.3x 实时）。 */
  speedX?: number;
  /** 已下载分片数 / 清单段数。 */
  segDone?: number;
  segTotal?: number;
  /** 预计剩余秒数（按媒体时间或分片数估算）。 */
  etaSec?: number;
  /** 最近几秒没有新数据（网络卡住/等待重试）。 */
  stalled?: boolean;
}

export interface TrackerOptions {
  /** 清单 `#EXTINF` 累加时长。 */
  manifestDurationSec: number;
  /** 正在写出的文件：用它的实际大小算「已下载字节/速度」（mp4 中途 total_size 常为 N/A）。 */
  outPath?: string;
  /** 清单里的分片总数（来自 #EXTINF 计数）。 */
  segTotal?: number;
  /** 注入时钟，便于单测。 */
  now?: () => number;
  /** 判定「卡住」的静默阈值（毫秒），默认 5000。 */
  stallMs?: number;
}

const SEGMENT_EXT = /\.(ts|m4s|mp4|m4a|aac|m4v)(\?|$)/i;
const OPENING_RE = /Opening '([^']+)' for reading/i;

/** 抹掉 URL 里的 auth_key 等签名，避免写进日志/报告。 */
export function scrubSecrets(text: string): string {
  return text
    .replace(/(auth_key=)[^&\s'"<>]+/gi, '$1***')
    .replace(/(token=)[^&\s'"<>]+/gi, '$1***');
}

/** 解析 `-progress` 的一行 `key=value`。 */
export function parseProgressLine(line: string): { key: string; value: string } | null {
  const eq = line.indexOf('=');
  if (eq <= 0) return null;
  return { key: line.slice(0, eq).trim(), value: line.slice(eq + 1).trim() };
}

/** 解析 ffmpeg 的 `speed= 1.23x` / `speed=N/A`。 */
export function parseSpeedX(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const m = /^([\d.]+)x$/.exec(value.trim());
  if (!m?.[1]) return undefined;
  const n = Number.parseFloat(m[1]);
  return Number.isFinite(n) ? n : undefined;
}

export class ProgressTracker {
  private readonly startedAt: number;
  private readonly now: () => number;
  private readonly stallMs: number;
  private readonly manifestDurationSec: number;
  private readonly segTotal?: number;
  private readonly outPath?: string;

  private readonly openedSegments = new Set<string>();
  private outTimeSec = 0;
  private bytes = 0;
  private speedX?: number;

  private lastBytes = 0;
  private lastBytesAt = 0;
  private hasByteSample = false;
  private emaBytesPerSec = 0;
  private lastActivityAt: number;

  private percent = 0;

  constructor(opts: TrackerOptions) {
    this.manifestDurationSec = Math.max(0, opts.manifestDurationSec);
    this.segTotal = opts.segTotal && opts.segTotal > 0 ? opts.segTotal : undefined;
    this.outPath = opts.outPath;
    this.now = opts.now ?? ((): number => Date.now());
    this.stallMs = opts.stallMs ?? 5000;
    this.startedAt = this.now();
    this.lastActivityAt = this.startedAt;
    this.lastBytesAt = this.startedAt;
  }

  /** 喂一行 ffmpeg stderr：只关心分片打开事件（用于段级进度）。 */
  feedStderrLine(line: string): void {
    const m = OPENING_RE.exec(line);
    if (!m?.[1]) return;
    const url = m[1];
    if (!SEGMENT_EXT.test(url)) return; // 排除 m3u8 / key
    if (!this.openedSegments.has(url)) {
      this.openedSegments.add(url);
      this.lastActivityAt = this.now();
    }
  }

  /**
   * 喂一行 ffmpeg stdout（`-progress`）。返回 null 表示这行不是进度块结束标记。
   */
  feedStdoutLine(line: string): DownloadProgress | null {
    const parsed = parseProgressLine(line);
    if (!parsed) return null;
    const { key, value } = parsed;

    if (key === 'out_time_us' || key === 'out_time_ms') {
      // 注：ffmpeg 的 out_time_ms 实际也是微秒（历史遗留命名）
      const us = Number.parseInt(value, 10);
      if (Number.isFinite(us) && us >= 0) this.outTimeSec = Math.max(this.outTimeSec, us / 1_000_000);
      return null;
    }
    if (key === 'total_size') {
      const n = Number.parseInt(value, 10);
      if (Number.isFinite(n) && n >= 0) {
        const now = this.now();
        this.recordBytes(n, now);
      }
      return null;
    }
    if (key === 'speed') {
      this.speedX = parseSpeedX(value);
      return null;
    }
    if (key === 'progress') {
      this.sampleFileBytes();
      return this.snapshot();
    }
    return null;
  }

  /** 用输出文件的实际大小补充字节/速度（mp4 的 total_size 中途可能是 N/A）。 */
  private sampleFileBytes(): void {
    if (!this.outPath) return;
    try {
      const size = statSync(this.outPath).size;
      if (size > 0) this.recordBytes(size, this.now());
    } catch {
      /* 文件还没创建/正被占用 */
    }
  }

  private recordBytes(n: number, now: number): void {
    if (!Number.isFinite(n) || n <= this.lastBytes) {
      if (Number.isFinite(n)) this.bytes = Math.max(this.bytes, n);
      return;
    }
    this.lastActivityAt = now;
    if (!this.hasByteSample) {
      // 第一个样本只当基线：否则会把「从 0 到首块」也算成 1 秒内的速度
      this.hasByteSample = true;
      this.lastBytesAt = now;
    } else {
      const dt = (now - this.lastBytesAt) / 1000;
      if (dt > 0.05) {
        const inst = (n - this.lastBytes) / dt;
        this.emaBytesPerSec = this.emaBytesPerSec > 0 ? this.emaBytesPerSec * 0.6 + inst * 0.4 : inst;
        this.lastBytesAt = now;
      }
    }
    this.lastBytes = n;
    this.bytes = Math.max(this.bytes, n);
  }

  /** 段级比时间级更贴近「下载」，取较大者；运行期封顶 99.5。 */
  private computePercent(): number {
    const segPct = this.segTotal ? (this.openedSegments.size / this.segTotal) * 100 : 0;
    const timePct = this.manifestDurationSec > 0 ? (this.outTimeSec / this.manifestDurationSec) * 100 : 0;
    const raw = Math.max(segPct, timePct);
    const capped = Math.min(raw, 99.5);
    // 单调不减，避免 ffmpeg 时间戳回跳导致进度倒退
    this.percent = Math.max(this.percent, Number.isFinite(capped) ? capped : 0);
    return this.percent;
  }

  private computeEta(percent: number): number | undefined {
    if (percent <= 0 || percent >= 100) return undefined;
    const elapsed = (this.now() - this.startedAt) / 1000;
    if (elapsed < 2) return undefined;
    return (elapsed / percent) * (100 - percent);
  }

  snapshot(): DownloadProgress {
    const percent = this.computePercent();
    const etaSec = this.computeEta(percent);
    const stalled = this.now() - this.lastActivityAt > this.stallMs;
    return {
      percent: Number(percent.toFixed(1)),
      timeSec: Number(this.outTimeSec.toFixed(2)),
      ...(this.bytes > 0 ? { bytes: this.bytes } : {}),
      ...(this.emaBytesPerSec > 0 && !stalled ? { bytesPerSec: Math.round(this.emaBytesPerSec) } : {}),
      ...(this.speedX === undefined ? {} : { speedX: this.speedX }),
      ...(this.segTotal === undefined ? {} : { segDone: this.openedSegments.size, segTotal: this.segTotal }),
      ...(etaSec === undefined ? {} : { etaSec: Math.round(etaSec) }),
      ...(stalled ? { stalled: true } : {}),
    };
  }

  /** ffmpeg 正常退出后调用：补一次 100%。 */
  finish(outPath?: string): DownloadProgress {
    let bytes = this.bytes;
    if (outPath) {
      try {
        bytes = Math.max(bytes, statSync(outPath).size);
      } catch {
        /* 文件还没落盘就沿用 total_size */
      }
    }
    this.percent = 100;
    return {
      percent: 100,
      timeSec: Number(this.outTimeSec.toFixed(2)),
      ...(bytes > 0 ? { bytes } : {}),
      ...(this.speedX === undefined ? {} : { speedX: this.speedX }),
      ...(this.segTotal === undefined ? {} : { segDone: this.openedSegments.size, segTotal: this.segTotal }),
    };
  }
}
