/**
 * 单条任务流水线（PLAN §6.3 + §8 M4/M5）。
 *
 * resolve → 命名 → ffmpeg 转封装(.part) → 全量解码核验 → rename 成交付名
 * 失败按「整片重取清单」重试，轮数由 `--retries` 给（默认 2），轮间 1s→2s→4s 退避。
 * 浏览器阶段恒串行；本模块只负责「一条」，并发/队列在上层（CLI / server）。
 */
import { existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { writeAssets } from './assets/index.js';
import { backoffDelay, sleep } from './net.js';
import { browserLock, type Mutex } from './concurrency.js';
import { AppError, classifyError } from './errors.js';
import {
  checkMediaTools,
  downloadWithFfmpeg,
  partPathFor,
  stalePathFor,
  verifyMedia,
  type VerifyResult,
} from './download/index.js';
import { buildBaseName, extForContainer, resolveOutputPath, sanitizeFileName, sidecarPath } from './naming/index.js';
import { resolveOne, type BrowserChannel, type ResolvedVideo } from './resolve.js';
import type {
  ContainerFormat,
  InputItem,
  NameMode,
  OnExist,
  TaskProgress,
  TaskResult,
  TaskStatus,
} from './types.js';

export type TaskEvent =
  | { type: 'task'; taskId: string; url: string; status: TaskStatus; index?: number; total?: number }
  | { type: 'progress'; taskId: string; progress: TaskProgress }
  | { type: 'log'; taskId?: string; level: 'info' | 'warn' | 'error'; message: string }
  | { type: 'done'; taskId: string; result: TaskResult };

export interface PipelineOptions {
  outDir: string;
  container: ContainerFormat;
  nameMode: NameMode;
  name?: string;
  template?: string;
  onExist: OnExist;
  retries: number;
  meta: boolean;
  cover: boolean;
  danmaku: boolean;
  subtitle: boolean;
  workDir: string;
  ffmpegPath?: string;
  ffprobePath?: string;
  channel?: BrowserChannel;
  chromePath?: string;
  proxy?: string;
  cookieFile?: string;
  egoPath?: string;
  timeoutSec?: number;
  /** 简版续传：复用未过期清单恢复未完成任务。 */
  resume?: boolean;
  /** 浏览器阶段串行锁（并发 >1 时保证取清单不并行）。 */
  browserLock?: Mutex;
  /** 注入解析实现（单测用；默认 core 的 resolveOne）。 */
  resolveFn?: typeof resolveOne;
  onEvent?: (e: TaskEvent) => void;
  signal?: AbortSignal;
}

export interface RunTaskInput {
  item: InputItem;
  index: number;
  total: number;
  taskId: string;
}

interface AttemptContext {
  resolved: ResolvedVideo;
  baseName: string;
  targetPath: string;
}

const emit = (opts: PipelineOptions, e: TaskEvent): void => {
  try {
    opts.onEvent?.(e);
  } catch {
    /* 事件处理异常不能毁掉任务 */
  }
};

const logInfo = (opts: PipelineOptions, taskId: string, message: string): void =>
  emit(opts, { type: 'log', taskId, level: 'info', message });

const logWarn = (opts: PipelineOptions, taskId: string, message: string): void =>
  emit(opts, { type: 'log', taskId, level: 'warn', message });

function buildResult(
  taskId: string,
  item: InputItem,
  status: TaskResult['status'],
  extra: Partial<TaskResult> = {},
): TaskResult {
  return { taskId, url: item.url, status, ...extra };
}

/**
 * 跑一条任务（含重试）。**不抛异常**：所有失败都变成 `TaskResult{status:'failed'}`，
 * 保证批量里一条失败不影响其它条（PLAN §8 验收口径 2）。
 */
export async function runTask(input: RunTaskInput, opts: PipelineOptions): Promise<TaskResult> {
  const startedAt = Date.now();
  let lastCtx: AttemptContext | null = null;
  const { item, index, total, taskId } = input;
  let attempts = 0;
  let lastError: AppError | null = null;
  let skipped = false;

  emit(opts, { type: 'task', taskId, url: item.url, status: 'queued', index, total });

  for (let attempt = 1; attempt <= Math.max(1, opts.retries); attempt++) {
    attempts = attempt;
    try {
      // ---- 1. 解析（每轮都重取清单：分片签名只有几分钟时效）----
      emit(opts, { type: 'task', taskId, url: item.url, status: 'resolving', index, total });
      const lock = opts.browserLock ?? browserLock;
      const resolveFn = opts.resolveFn ?? resolveOne;
      const resolved = await lock.run(() => resolveFn(item, {
        channel: opts.channel ?? 'auto',
        workDir: opts.workDir,
        timeoutSec: opts.timeoutSec ?? 30,
        log: (m) => logInfo(opts, taskId, m),
        warn: (m) => logWarn(opts, taskId, m),
        ...(opts.chromePath === undefined ? {} : { chromePath: opts.chromePath }),
        ...(opts.proxy === undefined ? {} : { proxy: opts.proxy }),
        ...(opts.cookieFile === undefined ? {} : { cookieFile: opts.cookieFile }),
        ...(opts.egoPath === undefined ? {} : { egoPath: opts.egoPath }),
        ...(opts.signal === undefined ? {} : { signal: opts.signal }),
      }));
      if (resolved.warn) logWarn(opts, taskId, resolved.warn);
      // 用户已经按了 Ctrl+C：别再下新的了
      if (opts.signal?.aborted) throw new AppError('USER_ABORT', '已中断，未开始下载');

      // ---- 2. 命名 ----
      const ext = extForContainer(opts.container);
      const baseName = buildBaseName({
        mode: opts.nameMode,
        ext,
        index,
        meta: resolved.meta,
        ...(opts.name === undefined ? {} : { name: opts.name }),
        ...(opts.template === undefined ? {} : { template: opts.template }),
      });
      mkdirSync(opts.outDir, { recursive: true });
      const target = resolveOutputPath({
        dir: opts.outDir,
        baseName,
        ext,
        onExist: opts.onExist,
        exists: (p) => existsSync(p),
        join: (dir, file) => resolve(join(dir, file)),
      });
      if (target.action === 'skip') {
        skipped = true;
        logInfo(opts, taskId, `已存在同名文件，按 --on-exist skip 跳过: ${target.path}`);
        return buildResult(taskId, item, 'skipped', {
          title: resolved.meta.title,
          filePath: target.path,
          attempts,
          elapsedMs: Date.now() - startedAt,
        });
      }

      const ctx: AttemptContext = { resolved, baseName, targetPath: target.path };
      lastCtx = ctx;

      // ---- 3. 续传：核验已有 .part，干净就直接转正 ----
      if (opts.resume && attempt === 1) {
        const reused = await tryResume(ctx, opts, taskId);
        if (reused) {
          return buildResult(taskId, item, 'success', {
            title: ctx.resolved.meta.title,
            filePath: target.path,
            ...(reused.fileSize === undefined ? {} : { fileSize: reused.fileSize }),
            verified: {
              frames: reused.frames,
              durationSec: reused.durationSec,
              manifestDurationSec: ctx.resolved.manifest.durationSec,
            },
            attempts,
            elapsedMs: Date.now() - startedAt,
          });
        }
      }

      // ---- 4. 下载 ----
      const partPath = partPathFor(target.path, attempt, opts.container);
      rmSync(partPath, { force: true });
      emit(opts, { type: 'task', taskId, url: item.url, status: 'downloading', index, total });
      logInfo(
        opts,
        taskId,
        `开始下载：${ctx.resolved.manifest.segments} 段 / ${ctx.resolved.manifest.durationSec.toFixed(1)}s` +
          `${ctx.resolved.manifest.variantBandwidth ? ` / ${Math.round(ctx.resolved.manifest.variantBandwidth / 1000)}kbps` : ''}`,
      );

      const dl = await downloadWithFfmpeg({
        manifestPath: ctx.resolved.manifestPath,
        outPath: partPath,
        manifestDurationSec: ctx.resolved.manifest.durationSec,
        segTotal: ctx.resolved.manifest.segments,
        ...(opts.ffmpegPath === undefined ? {} : { ffmpegPath: opts.ffmpegPath }),
        ...(opts.signal === undefined ? {} : { signal: opts.signal }),
        onProgress: (p) => {
          emit(opts, {
            type: 'progress',
            taskId,
            progress: {
              percent: p.percent,
              timeSec: p.timeSec,
              segTotal: p.segTotal ?? ctx.resolved.manifest.segments,
              ...(p.bytes === undefined ? {} : { bytes: p.bytes }),
              ...(p.bytesPerSec === undefined ? {} : { bytesPerSec: p.bytesPerSec }),
              ...(p.speedX === undefined ? {} : { speedX: p.speedX }),
              ...(p.etaSec === undefined ? {} : { etaSec: p.etaSec }),
              ...(p.stalled === undefined ? {} : { stalled: p.stalled }),
              ...(p.segDone === undefined ? {} : { segDone: p.segDone }),
            },
          });
        },
      });

      if (dl.aborted || opts.signal?.aborted) {
        // 用户中断：保留 .part，交给 --resume（PLAN Q9）
        throw new AppError('USER_ABORT', '已中断，保留 .part 与清单以便 --resume 继续');
      }
      if (dl.code !== 0) {
        const tail = dl.stderr.trim().split(/\r?\n/).slice(-3).join(' | ');
        throw new AppError('FFMPEG_FAILED', `ffmpeg 退出码 ${dl.code}${tail ? `: ${tail}` : ''}`, { detail: dl.stderr });
      }

      // ---- 5. 核验（不可跳过）----
      emit(opts, { type: 'task', taskId, url: item.url, status: 'verifying', index, total });
      const v = await verifyMedia({
        path: partPath,
        manifestDurationSec: ctx.resolved.manifest.durationSec,
        ...(opts.ffmpegPath === undefined ? {} : { ffmpegPath: opts.ffmpegPath }),
        ...(opts.ffprobePath === undefined ? {} : { ffprobePath: opts.ffprobePath }),
      });
      if (!v.ok) {
        rmSync(partPath, { force: true });
        throw new AppError('VERIFY_FAILED', v.reason ?? '核验未通过');
      }

      // ---- 6. 转正 ----
      if (target.action === 'overwrite') rmSync(target.path, { force: true });
      renameSync(partPath, target.path);
      const fileSize = statSync(target.path).size;
      logInfo(opts, taskId, `核验通过：${v.frames} 帧 / ${v.durationSec.toFixed(1)}s / ${fileSize} 字节`);

      // ---- 7. 附加资源（失败只告警，不阻塞交付）----
      const assets = await writeAssets(
        {
          dir: opts.outDir,
          baseName: basename(target.path, ext),
          meta: ctx.resolved.meta,
          pageUrl: ctx.resolved.target.url,
          generation: ctx.resolved.target.generation,
          manifestDurationSec: ctx.resolved.manifest.durationSec,
          segments: ctx.resolved.manifest.segments,
          ...(ctx.resolved.manifest.variantBandwidth === undefined
            ? {}
            : { variantBandwidth: ctx.resolved.manifest.variantBandwidth }),
          verified: { frames: v.frames, durationSec: v.durationSec, manifestDurationSec: ctx.resolved.manifest.durationSec },
          fileSize,
        },
        {
          meta: opts.meta,
          cover: opts.cover,
          danmaku: opts.danmaku,
          subtitle: opts.subtitle,
          timeoutMs: (opts.timeoutSec ?? 30) * 1000,
        },
      );
      for (const w of assets.warnings) logWarn(opts, taskId, w);

      const result = buildResult(taskId, item, 'success', {
        title: ctx.resolved.meta.title,
        filePath: target.path,
        fileSize,
        verified: { frames: v.frames, durationSec: v.durationSec, manifestDurationSec: ctx.resolved.manifest.durationSec },
        attempts,
        elapsedMs: Date.now() - startedAt,
      });
      emit(opts, { type: 'task', taskId, url: item.url, status: 'done', index, total });
      emit(opts, { type: 'done', taskId, result });
      return result;
    } catch (e) {
      const err = classifyError(e, 'UNKNOWN');
      lastError = err;
      logWarn(opts, taskId, `第 ${attempt} 轮失败：${err.kind}: ${err.message}`);

      // 需鉴权/内容不可播/用户中断：不重试，立即停
      if (err.kind === 'USER_ABORT') {
        // 落 resume.json：目标路径、清单 URL、auth_key 过期时间、attempt（PLAN Q9）
        try {
          writeResumeState(opts.outDir, {
            taskId,
            url: item.url,
            attempt,
            ...(lastCtx === null ? {} : { targetPath: lastCtx.targetPath }),
            ...(lastCtx === null ? {} : { playlistUrl: lastCtx.resolved.manifest.playlistUrl }),
            ...(lastCtx?.resolved.manifest.keyExpireAt === undefined
              ? {}
              : { keyExpireAt: lastCtx.resolved.manifest.keyExpireAt }),
          });
        } catch {
          /* resume 状态写不出来不影响退出语义 */
        }
        break;
      }
      if (!err.retryable) break;
      if (attempt >= Math.max(1, opts.retries)) break;
      const delay = backoffDelay(attempt);
      logInfo(opts, taskId, `整片重取清单重试（${delay}ms 后第 ${attempt + 1} 轮）…`);
      await sleep(delay);
    }
  }

  const status: TaskStatus = lastError?.kind === 'CANCELED' ? 'canceled' : 'failed';
  emit(opts, { type: 'task', taskId, url: item.url, status, index, total });
  const failedResult = buildResult(taskId, item, 'failed', {
    attempts,
    elapsedMs: Date.now() - startedAt,
    ...(lastError === null
      ? { errorKind: 'UNKNOWN', message: '未知失败' }
      : { errorKind: lastError.kind, message: lastError.message, suggestion: lastError.suggestion }),
  });
  if (skipped) return buildResult(taskId, item, 'skipped', {});
  emit(opts, { type: 'done', taskId, result: failedResult });
  return failedResult;
}

interface ResumeOutcome {
  frames: number;
  durationSec: number;
  fileSize?: number;
}

/**
 * 简版续传（PLAN §6.3）：
 *   1. 清单签名仍有效 → 对已存在 `.part.<ext>` 先做一次核验，通过则直接转正；
 *   2. 签名已过期 → 过期残件改名 `.part.stale-<ts>` 保留，然后整片重下。
 */
async function tryResume(ctx: AttemptContext, opts: PipelineOptions, taskId: string): Promise<ResumeOutcome | null> {
  const partPath = partPathFor(ctx.targetPath, 1, opts.container);
  if (!existsSync(partPath)) return null;

  const expireAt = ctx.resolved.manifest.keyExpireAt;
  const expired = expireAt !== undefined && Date.now() + 30_000 >= expireAt;
  if (expired) {
    const stale = stalePathFor(ctx.targetPath, opts.container);
    try {
      renameSync(partPath, stale);
      logWarn(opts, taskId, `清单签名已过期，旧的 .part 改名保留: ${stale}`);
    } catch {
      rmSync(partPath, { force: true });
    }
    return null;
  }

  logInfo(opts, taskId, '发现未过期的 .part，先核验再决定是否复用…');
  const v = await verifyMedia({
    path: partPath,
    manifestDurationSec: ctx.resolved.manifest.durationSec,
    ...(opts.ffmpegPath === undefined ? {} : { ffmpegPath: opts.ffmpegPath }),
    ...(opts.ffprobePath === undefined ? {} : { ffprobePath: opts.ffprobePath }),
  });
  if (!v.ok) {
    logWarn(opts, taskId, `已有 .part 核验不通过（${v.reason ?? '未知'}），覆盖重下`);
    rmSync(partPath, { force: true });
    return null;
  }
  if (existsSync(ctx.targetPath)) rmSync(ctx.targetPath, { force: true });
  renameSync(partPath, ctx.targetPath);
  const size = statSync(ctx.targetPath).size;
  logInfo(opts, taskId, `续传成功：复用 .part → ${ctx.targetPath}`);
  return { frames: v.frames, durationSec: v.durationSec, fileSize: size };
}

/** 写 resume.json（中断时调用，便于 --resume 判断清单是否还有效）。 */
export function writeResumeState(
  outDir: string,
  state: { taskId: string; url: string; targetPath?: string; playlistUrl?: string; keyExpireAt?: number; attempt: number },
): string {
  const dir = join(outDir, 'reports');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `resume-${sanitizeFileName(state.taskId, { ext: '.json' })}.json`);
  writeFileSync(file, JSON.stringify({ ...state, savedAt: new Date().toISOString() }, null, 2), 'utf8');
  return file;
}

/** 前置检查：ffmpeg/ffprobe 必须在（启动即失败，不等到最后一刻）。 */
export async function preflight(opts: PipelineOptions): Promise<void> {
  await checkMediaTools(opts.ffmpegPath ?? 'ffmpeg', opts.ffprobePath ?? 'ffprobe');
  mkdirSync(opts.workDir, { recursive: true });
  mkdirSync(opts.outDir, { recursive: true });
}

export type { VerifyResult };
