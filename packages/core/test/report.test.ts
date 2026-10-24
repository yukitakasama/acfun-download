import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpDir } from './helpers/tmp.js';
import { describe, expect, it } from 'vitest';
import {
  buildFailuresReport,
  buildResultCsv,
  buildResultReport,
  summarizeResults,
  timestampSlug,
  writeReports,
  type TaskResult,
} from '../src/index.js';

const results: TaskResult[] = [
  {
    taskId: 't1',
    url: 'https://d.work/community/1',
    title: '正常视频',
    status: 'success',
    filePath: 'D:/out/正常视频.mp4',
    fileSize: 1024 * 1024,
    verified: { frames: 100, durationSec: 10, manifestDurationSec: 10 },
    attempts: 1,
    elapsedMs: 5000,
  },
  {
    taskId: 't2',
    url: 'https://d.work/community/2',
    title: '已存在',
    status: 'skipped',
    filePath: 'D:/out/已存在.mp4',
    attempts: 1,
    elapsedMs: 300,
  },
  {
    taskId: 't3',
    url: 'https://d.work/community/3',
    status: 'failed',
    errorKind: 'AUTH_REQUIRED',
    message: '需要登录或购买',
    suggestion: '换公开内容',
    attempts: 1,
    elapsedMs: 2000,
  },
];

describe('汇总统计', () => {
  it('成功/跳过/失败分别计数，字节数累加', () => {
    const s = summarizeResults(results);
    expect(s).toMatchObject({ total: 3, success: 1, skipped: 1, failed: 1, totalBytes: 1024 * 1024 });
  });
});

describe('JSON 报告', () => {
  it('结构含 generatedAt/summary/results，且每条任务都在', () => {
    const now = new Date('2026-10-24T10:00:00Z');
    const r = buildResultReport(results, now);
    expect(r.generatedAt).toBe(now.toISOString());
    expect(r.summary.total).toBe(3);
    expect(r.results.map((x) => x.taskId)).toEqual(['t1', 't2', 't3']);
  });

  it('失败清单只含失败条目，并带 kind/message/suggestion', () => {
    const f = buildFailuresReport(results);
    expect(f.count).toBe(1);
    expect(f.failures[0]).toMatchObject({
      taskId: 't3',
      errorKind: 'AUTH_REQUIRED',
      message: '需要登录或购买',
      suggestion: '换公开内容',
    });
  });

  it('没有失败时 count=0（仍然写出文件，能证明「查过了」）', () => {
    expect(buildFailuresReport([results[0]!]).count).toBe(0);
  });
});

describe('CSV 报告', () => {
  it('表头固定且每行一条任务', () => {
    const csv = buildResultCsv(results);
    const lines = csv.trim().split('\n');
    expect(lines[0]).toBe(
      'taskId,status,url,title,filePath,fileSize,frames,durationSec,manifestDurationSec,errorKind,message,attempts,elapsedMs',
    );
    expect(lines).toHaveLength(4);
    expect(lines[1]).toContain('t1,success');
    expect(lines[1]).toContain('100');
  });

  it('含逗号/引号的字段被正确转义', () => {
    const csv = buildResultCsv([
      { taskId: 't1', url: 'u', status: 'failed', message: 'a,b "c"', errorKind: 'UNKNOWN' },
    ]);
    const row = csv.trim().split('\n')[1] ?? '';
    expect(row).toContain('"a,b ""c"""');
  });
});

describe('writeReports 落盘', () => {
  it('json 模式写 <ts>-result.json 与 failures-<ts>.json', () => {
    const outDir = tmpDir('acfun-rep-');
    const now = new Date('2026-10-24T10:20:30');
    const out = writeReports({ outDir, results, format: 'json', now });
    expect(out.resultFile).toContain(`reports/${timestampSlug(now)}-result.json`.replace(/\//g, require('node:path').sep));
    const json = JSON.parse(readFileSync(out.resultFile!, 'utf8'));
    expect(json.summary.failed).toBe(1);
    const failures = JSON.parse(readFileSync(out.failuresFile!, 'utf8'));
    expect(failures.count).toBe(1);
  });

  it('csv 模式写 <ts>-result.csv', () => {
    const outDir = tmpDir('acfun-rep-');
    const out = writeReports({ outDir, results, format: 'csv', now: new Date('2026-10-24T10:20:30') });
    expect(out.resultFile!.endsWith('.csv')).toBe(true);
    expect(readFileSync(out.resultFile!, 'utf8')).toContain('taskId,status');
  });

  it('时间戳格式 YYYYMMDD-HHmmss', () => {
    expect(timestampSlug(new Date(2026, 9, 24, 15, 30, 12))).toBe('20261024-153012');
  });
});
