/**
 * CLI 任务执行器：把 core 的 runTask 跑成「批量 + 并发语义 + 进度显示 + 退出码」。
 *
 * 并发语义（PLAN §6.5）：任务级并发由 --concurrency 控制，但浏览器取清单阶段
 * 通过 browserLock 恒串行；真正的并行只发生在 ffmpeg 下载/核验阶段。
 */
import {
  mapWithConcurrency,
  runTask,
  type InputItem,
  type PipelineOptions,
  type TaskEvent,
  type TaskProgress,
  type TaskResult,
} from '@acfun/core';
import type { CliLog } from './io.js';

export interface RunnerConfig {
  items: readonly InputItem[];
  pipeline: PipelineOptions;
  concurrency: number;
  intervalMs: number;
  log: CliLog;
  signal: AbortSignal;
}

export interface RunnerOutcome {
  results: TaskResult[];
  /** 有任务被用户中断。 */
  aborted: boolean;
}

function formatProgress(p: TaskProgress, totalSec?: number): string {
  const total = totalSec && totalSec > 0 ? `${totalSec.toFixed(0)}s` : '?';
  return `${p.percent.toFixed(1)}%  ${p.timeSec.toFixed(0)}s/${total}`;
}

/** 跑完所有任务。结果顺序与输入顺序一致。 */
export async function runAll(cfg: RunnerConfig): Promise<RunnerOutcome> {
  const { items, pipeline, log, signal } = cfg;
  const total = items.length;

  const onEvent = (ev: TaskEvent): void => {
    if (log.jsonMode) {
      log.emit(ev);
      return;
    }
    switch (ev.type) {
      case 'task': {
        const pos = ev.index === undefined ? '' : `[${ev.index}/${ev.total ?? total}] `;
        if (ev.status === 'queued') log.info(`${pos}开始: ${ev.url}`);
        else if (ev.status === 'resolving') log.info(`${pos}解析中…`);
        else if (ev.status === 'downloading') log.info(`${pos}下载中…`);
        else if (ev.status === 'verifying') log.info(`${pos}核验中…`);
        break;
      }
      case 'progress': {
        const line = `  ${formatProgress(ev.progress)}`;
        if (process.stderr.isTTY) process.stderr.write(`\r${line.padEnd(60)}`);
        break;
      }
      case 'log': {
        if (ev.level === 'warn') log.warn(ev.message);
        else if (ev.level === 'error') log.error(ev.message);
        else log.info(ev.message);
        break;
      }
      case 'done':
        break;
      default:
        break;
    }
  };

  const results = await mapWithConcurrency(
    items,
    async (item, index) => {
      const taskId = `t${index + 1}`;
      try {
        return await runTask(
          { item, index: index + 1, total, taskId },
          { ...pipeline, onEvent },
        );
      } catch (e) {
        log.debug(`任务级异常: ${e instanceof Error ? e.message : String(e)}`);
        return {
          taskId,
          url: item.url,
          status: 'failed' as const,
          errorKind: 'UNKNOWN',
          message: e instanceof Error ? e.message : String(e),
        };
      }
    },
    {
      limit: Math.max(1, cfg.concurrency),
      intervalMs: cfg.intervalMs,
      signal,
    },
  );

  if (!log.jsonMode && process.stderr.isTTY) process.stderr.write('\n');

  const aborted = signal.aborted || results.some((r) => r.errorKind === 'USER_ABORT');
  return { results, aborted };
}

/** 汇总打印（每条任务结束都必须打印最终路径与状态 —— PLAN §8 验收口径 2）。 */
export function summarize(results: readonly TaskResult[], log: CliLog): void {
  const ok = results.filter((r) => r.status === 'success').length;
  const skipped = results.filter((r) => r.status === 'skipped').length;
  const failed = results.filter((r) => r.status === 'failed').length;
  log.info('');
  log.info(`======== 汇总：成功 ${ok} / 跳过 ${skipped} / 失败 ${failed}（共 ${results.length}）========`);
  for (const r of results) {
    const size = r.fileSize ? ` ${(r.fileSize / 1024 / 1024).toFixed(1)}MB` : '';
    if (r.status === 'success') {
      log.info(`✓ ${r.filePath ?? '(无路径)'}${size}${r.verified ? ` | ${r.verified.frames} 帧 / ${r.verified.durationSec.toFixed(1)}s` : ''}`);
    } else if (r.status === 'skipped') {
      log.info(`= 跳过 ${r.filePath ?? r.url}`);
    } else {
      log.error(`✗ ${r.url}\n    ${r.errorKind}: ${r.message}\n    建议: ${r.suggestion ?? ''}`);
    }
  }
}

/** 退出码：0 全成功 | 3 部分或全部失败 | 130 用户中断。 */
export function exitCodeFor(outcome: RunnerOutcome): number {
  if (outcome.aborted) return 130;
  const failed = outcome.results.filter((r) => r.status === 'failed').length;
  if (failed > 0) return 3;
  return 0;
}
