import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpDir } from './helpers/tmp.js';
import { describe, expect, it } from 'vitest';
import { writeReports, type InputItem, type PipelineOptions, type TaskResult } from '@acfun/core';
import { CliLog } from '../src/io.js';
import { exitCodeFor, runAll, summarize } from '../src/runner.js';

const log = new CliLog({ json: false, verbose: false });

const items: InputItem[] = [
  { raw: 'https://d.work/community/1', url: 'https://d.work/community/1', source: 'arg' },
  { raw: 'https://d.work/community/2', url: 'https://d.work/community/2', source: 'arg' },
  { raw: 'https://d.work/community/999999999', url: 'https://d.work/community/999999999', source: 'arg' },
];

const pipeline = {
  outDir: 'unused',
  container: 'mp4',
  nameMode: 'title',
  onExist: 'rename',
  retries: 1,
  meta: false,
  cover: false,
  danmaku: false,
  subtitle: false,
  workDir: 'unused',
} as PipelineOptions;

/** 模拟「成功 / 跳过 / 失败」各一条（不联网）。 */
const fakeRunner = async (input: {
  item: InputItem;
  taskId: string;
}): Promise<TaskResult> => {
  const { item, taskId } = input;
  if (item.url.endsWith('/1')) {
    return { taskId, url: item.url, status: 'success', title: '正常', filePath: 'D:/out/a.mp4', fileSize: 100, attempts: 1 };
  }
  if (item.url.endsWith('/2')) {
    return { taskId, url: item.url, status: 'skipped', filePath: 'D:/out/b.mp4', attempts: 1 };
  }
  return {
    taskId,
    url: item.url,
    status: 'failed',
    errorKind: 'HTTP_404',
    message: '内容可能已下架',
    suggestion: '确认 id 是否有效',
    attempts: 2,
  };
};

describe('批量：独立成败 + 部分失败不被吞', () => {
  it('三条各自归位，退出码 3，失败清单含失败项', async () => {
    const outDir = tmpDir();
    const outcome = await runAll({
      items,
      pipeline,
      concurrency: 1,
      intervalMs: 0,
      log,
      signal: new AbortController().signal,
      taskRunner: fakeRunner as never,
    });

    expect(outcome.results.map((r) => r.status)).toEqual(['success', 'skipped', 'failed']);
    expect(outcome.aborted).toBe(false);
    expect(exitCodeFor(outcome)).toBe(3);

    const report = writeReports({ outDir, results: outcome.results, format: 'json' });
    expect(existsSync(report.failuresFile!)).toBe(true);
    const failures = JSON.parse(readFileSync(report.failuresFile!, 'utf8')) as {
      count: number;
      failures: Array<{ url: string; errorKind: string }>;
    };
    expect(failures.count).toBe(1);
    expect(failures.failures[0]?.url).toBe('https://d.work/community/999999999');
    expect(failures.failures[0]?.errorKind).toBe('HTTP_404');

    const result = JSON.parse(readFileSync(report.resultFile!, 'utf8')) as { summary: Record<string, number> };
    expect(result.summary).toMatchObject({ total: 3, success: 1, skipped: 1, failed: 1 });
  });

  it('全部成功时退出码 0', async () => {
    const outcome = await runAll({
      items: items.slice(0, 2),
      pipeline,
      concurrency: 1,
      intervalMs: 0,
      log,
      signal: new AbortController().signal,
      taskRunner: fakeRunner as never,
    });
    expect(exitCodeFor(outcome)).toBe(0);
  });

  it('用户中断时退出码 130', async () => {
    const controller = new AbortController();
    controller.abort();
    const outcome = await runAll({
      items,
      pipeline,
      concurrency: 1,
      intervalMs: 0,
      log,
      signal: controller.signal,
      taskRunner: fakeRunner as never,
    });
    expect(exitCodeFor(outcome)).toBe(130);
  });

  it('summarize 会打印每条任务的最终路径或错误建议（不静默）', () => {
    const lines: string[] = [];
    const spy = new CliLog({ json: false, verbose: false });
    const original = process.stderr.write.bind(process.stderr);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stderr as any).write = (chunk: string): boolean => {
      lines.push(String(chunk));
      return true;
    };
    try {
      summarize(
        [
          { taskId: 't1', url: 'u1', status: 'success', filePath: 'D:/out/a.mp4', fileSize: 1048576 },
          { taskId: 't2', url: 'u2', status: 'failed', errorKind: 'AUTH_REQUIRED', message: '需登录', suggestion: '换公开内容' },
        ],
        spy,
      );
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (process.stderr as any).write = original;
    }
    const text = lines.join('');
    expect(text).toContain('D:/out/a.mp4');
    expect(text).toContain('AUTH_REQUIRED');
    expect(text).toContain('换公开内容');
  });
});
