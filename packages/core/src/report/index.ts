/**
 * 汇总报告与失败清单（PLAN §6.4 输出 / §7.1 报告结构）。
 *
 * 产物：
 *   <out-dir>/reports/<ts>-result.json | .csv   全量结果
 *   <out-dir>/reports/failures-<ts>.json        只含失败条目（便于重跑）
 *
 * 硬性要求：**每条任务都要出现**（含 skipped），失败条目必须带 kind/message/suggestion，
 * 不允许「批量部分失败被吞成 exit 0」。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TaskResult } from '../types.js';

export interface ResultSummary {
  total: number;
  success: number;
  skipped: number;
  failed: number;
  totalBytes: number;
  elapsedMs: number;
}

export interface ResultReport {
  generatedAt: string;
  summary: ResultSummary;
  results: TaskResult[];
}

export interface FailuresReport {
  generatedAt: string;
  count: number;
  failures: Array<{
    url: string;
    taskId: string;
    errorKind: string;
    message: string;
    suggestion: string;
    attempts?: number;
  }>;
}

/** `20261024-153012` 形式的报告时间戳。 */
export function timestampSlug(d: Date = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function summarizeResults(results: readonly TaskResult[]): ResultSummary {
  let success = 0;
  let skipped = 0;
  let failed = 0;
  let totalBytes = 0;
  let elapsedMs = 0;
  for (const r of results) {
    if (r.status === 'success') success += 1;
    else if (r.status === 'skipped') skipped += 1;
    else failed += 1;
    if (r.fileSize) totalBytes += r.fileSize;
    if (r.elapsedMs) elapsedMs += r.elapsedMs;
  }
  return { total: results.length, success, skipped, failed, totalBytes, elapsedMs };
}

export function buildResultReport(results: readonly TaskResult[], now: Date = new Date()): ResultReport {
  return { generatedAt: now.toISOString(), summary: summarizeResults(results), results: [...results] };
}

export function buildFailuresReport(results: readonly TaskResult[], now: Date = new Date()): FailuresReport {
  const failures = results
    .filter((r) => r.status === 'failed')
    .map((r) => ({
      url: r.url,
      taskId: r.taskId,
      errorKind: r.errorKind ?? 'UNKNOWN',
      message: r.message ?? '',
      suggestion: r.suggestion ?? '',
      ...(r.attempts === undefined ? {} : { attempts: r.attempts }),
    }));
  return { generatedAt: now.toISOString(), count: failures.length, failures };
}

const CSV_COLUMNS = [
  'taskId',
  'status',
  'url',
  'title',
  'filePath',
  'fileSize',
  'frames',
  'durationSec',
  'manifestDurationSec',
  'errorKind',
  'message',
  'attempts',
  'elapsedMs',
] as const;

function csvCell(value: unknown): string {
  if (value === undefined || value === null) return '';
  const s = String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** 结果 → CSV（带表头，UTF-8；值为空则留空）。 */
export function buildResultCsv(results: readonly TaskResult[]): string {
  const rows: string[] = [CSV_COLUMNS.join(',')];
  for (const r of results) {
    const record: Record<(typeof CSV_COLUMNS)[number], unknown> = {
      taskId: r.taskId,
      status: r.status,
      url: r.url,
      title: r.title,
      filePath: r.filePath,
      fileSize: r.fileSize,
      frames: r.verified?.frames,
      durationSec: r.verified?.durationSec,
      manifestDurationSec: r.verified?.manifestDurationSec,
      errorKind: r.errorKind,
      message: r.message,
      attempts: r.attempts,
      elapsedMs: r.elapsedMs,
    };
    rows.push(CSV_COLUMNS.map((c) => csvCell(record[c])).join(','));
  }
  return `${rows.join('\n')}\n`;
}

export interface WriteReportOptions {
  outDir: string;
  results: readonly TaskResult[];
  format: 'json' | 'csv';
  now?: Date;
}

export interface WriteReportOutcome {
  resultFile?: string;
  failuresFile?: string;
  report: ResultReport;
}

/** 落盘：汇总 + 失败清单（失败清单永远写，哪怕没有失败——零失败也要能证明「查过了」）。 */
export function writeReports(opts: WriteReportOptions): WriteReportOutcome {
  const now = opts.now ?? new Date();
  const dir = join(opts.outDir, 'reports');
  mkdirSync(dir, { recursive: true });
  const ts = timestampSlug(now);
  const report = buildResultReport(opts.results, now);

  const resultFile = join(dir, `${ts}-result.${opts.format}`);
  if (opts.format === 'csv') writeFileSync(resultFile, buildResultCsv(opts.results), 'utf8');
  else writeFileSync(resultFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  const failures = buildFailuresReport(opts.results, now);
  const failuresFile = join(dir, `failures-${ts}.json`);
  writeFileSync(failuresFile, `${JSON.stringify(failures, null, 2)}\n`, 'utf8');

  return { resultFile, failuresFile, report };
}
