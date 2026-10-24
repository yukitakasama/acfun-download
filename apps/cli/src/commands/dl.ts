/**
 * `acfun dl` / `acfun batch` —— 下载（PLAN §8 M4/M5）。
 *
 * M4：单条/多条顺序下载 + 全量解码核验 + .part + 两轮整片重试。
 * M5：队列/并发语义/限速/续传/汇总报告/失败清单/退出码。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { classifyError, preflight, writeReports, type InputItem, type PipelineOptions } from '@acfun/core';
import type { CliOptions } from '../args.js';
import { collectInputs, CliLog, describeItem } from '../io.js';
import { exitCodeFor, runAll, summarize } from '../runner.js';
import { reportError } from './parse.js';

export async function runDownload(
  positionals: readonly string[],
  opts: CliOptions,
  log: CliLog,
  signal: AbortSignal,
): Promise<number> {
  let items: InputItem[];
  try {
    items = await collectInputs(positionals, opts);
  } catch (e) {
    reportError(classifyError(e, 'BAD_INPUT'), log, opts);
    return 1;
  }
  if (items.length === 0) {
    log.error('没有可下载的输入。给一个 URL/分享文本，或用 -f urls.txt / stdin。');
    return 1;
  }

  const outDir = resolve(opts.outDir);
  const workDir = process.env.ACFUN_WORK_DIR
    ? resolve(process.env.ACFUN_WORK_DIR)
    : mkdtempSync(join(tmpdir(), 'acfun-work-'));

  const pipeline: PipelineOptions = {
    outDir,
    container: opts.container,
    nameMode: opts.nameMode,
    onExist: opts.onExist,
    retries: opts.retries,
    meta: opts.meta,
    cover: opts.cover,
    danmaku: opts.danmaku,
    subtitle: opts.subtitle,
    workDir,
    channel: opts.channel ?? 'auto',
    timeoutSec: opts.timeoutSec,
    resume: opts.resume,
    ...(opts.name === undefined ? {} : { name: opts.name }),
    ...(opts.template === undefined ? {} : { template: opts.template }),
    ...(opts.ffmpeg === undefined ? {} : { ffmpegPath: opts.ffmpeg }),
    ...(opts.ffprobe === undefined ? {} : { ffprobePath: opts.ffprobe }),
    ...(opts.chrome === undefined ? {} : { chromePath: opts.chrome }),
    ...(opts.proxy === undefined ? {} : { proxy: opts.proxy }),
    ...(opts.cookie === undefined ? {} : { cookieFile: opts.cookie }),
  };

  // 前置检查：ffmpeg/ffprobe 缺失就启动即失败（不等到最后一刻）
  try {
    await preflight(pipeline);
  } catch (e) {
    reportError(classifyError(e, 'FFMPEG_MISSING'), log, opts);
    return 1;
  }

  log.info(`输出目录: ${outDir}`);
  log.info(`输入 ${items.length} 条${opts.concurrency > 1 ? `（并发 ${opts.concurrency}，仅 ffmpeg 阶段并行；浏览器取清单恒串行）` : ''}`);
  for (let i = 0; i < items.length; i++) log.debug(`${describeItem(items[i]!, i)} ${items[i]!.url}`);

  const outcome = await runAll({
    items,
    pipeline,
    concurrency: opts.concurrency,
    intervalMs: opts.intervalMs,
    log,
    signal,
  });

  summarize(outcome.results, log);

  // M5：汇总报告 + 失败清单
  const report = writeReports({ outDir, results: outcome.results, format: opts.report });
  if (report.resultFile) log.info(`汇总报告: ${report.resultFile}`);
  if (report.failuresFile) log.warn(`失败清单: ${report.failuresFile}`);

  if (log.jsonMode) {
    for (const r of outcome.results) log.emit(r);
  }

  return exitCodeFor(outcome);
}
