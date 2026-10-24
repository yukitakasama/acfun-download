/**
 * 任务队列与事件总线（PLAN §6.6）。
 *
 * - 提交 → 排队 → 按配置并发跑（浏览器阶段由 core 的 browserLock 串行）
 * - 每个状态变化 / 进度 / 日志 / 完成都推给 SSE 订阅者
 * - 历史与失败清单落盘（%APPDATA%\acfun-download\history.json）
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AppError,
  classifyError,
  normalizeInputs,
  itemsFromText,
  runTask,
  type InputItem,
  type PipelineOptions,
  type TaskEvent,
  type TaskProgress,
  type TaskResult,
  type TaskStatus,
} from '@acfun/core';
import { historyPath, toCoreSettings, type AppConfig } from './config.js';

export interface TaskView {
  id: string;
  url: string;
  raw: string;
  status: TaskStatus;
  percent: number;
  timeSec: number;
  /** 已写入字节 / 实时速度 / 倍速 / 预计剩余 / 是否卡住 / 分片进度 */
  bytes?: number;
  bytesPerSec?: number;
  speedX?: number;
  etaSec?: number;
  stalled?: boolean;
  segDone?: number;
  segTotal?: number;
  attempts: number;
  title?: string;
  outputPath?: string;
  fileSize?: number;
  errorKind?: string;
  message?: string;
  suggestion?: string;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
}

export type ServerEvent =
  | { type: 'task'; task: TaskView }
  | { type: 'progress'; taskId: string; progress: TaskProgress }
  | { type: 'log'; taskId?: string; level: 'info' | 'warn' | 'error'; message: string }
  | { type: 'done'; taskId: string; result: TaskResult }
  | { type: 'config'; config: AppConfig };

interface ManagedTask {
  view: TaskView;
  item: InputItem;
  controller: AbortController;
  result?: TaskResult;
}

export interface SubmitResult {
  created: TaskView[];
  skipped: Array<{ raw: string; reason: string }>;
}

const HISTORY_LIMIT = 300;

export class TaskManager {
  private readonly tasks = new Map<string, ManagedTask>();
  private readonly order: string[] = [];
  private readonly queue: string[] = [];
  private readonly subscribers = new Set<(e: ServerEvent) => void>();
  private running = 0;
  private seq = 0;
  private historyItems: TaskResult[] = [];
  private readonly workRoot: string;

  constructor(
    private readonly getConfig: () => AppConfig,
    private readonly setConfig: (patch: Partial<AppConfig>) => void = () => {},
  ) {
    this.workRoot = mkdtempSync(join(tmpdir(), 'acfun-server-'));
    this.historyItems = loadHistory();
  }

  subscribe(fn: (e: ServerEvent) => void): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  private emit(event: ServerEvent): void {
    for (const fn of this.subscribers) {
      try {
        fn(event);
      } catch {
        /* 单个订阅者异常不能影响其余 */
      }
    }
  }

  private log(level: 'info' | 'warn' | 'error', message: string, taskId?: string): void {
    this.emit({ type: 'log', level, message, ...(taskId === undefined ? {} : { taskId }) });
  }

  /** 提交输入（URL / 分享文本 / 多行文本）。自动去重，重复的进 skipped 列表而不是报错。 */
  async submit(rawInputs: readonly string[], text?: string): Promise<SubmitResult> {
    const cfg = this.getConfig();
    const items: InputItem[] = [];
    const skipped: Array<{ raw: string; reason: string }> = [];

    if (rawInputs.length > 0) items.push(...(await normalizeInputs(rawInputs, { timeoutMs: cfg.timeoutSec * 1000 })));
    if (text && text.trim()) items.push(...(await itemsFromText(text, 'stdin', { timeoutMs: cfg.timeoutSec * 1000 })));

    const seen = new Set<string>();
    const created: TaskView[] = [];
    for (const item of items) {
      const key = `${new URL(item.url).origin}${new URL(item.url).pathname}`;
      if (seen.has(key)) {
        skipped.push({ raw: item.raw, reason: '同一链接在本批里重复' });
        continue;
      }
      seen.add(key);
      // 已经在跑/已完成的同链接也跳过，避免误触重复下载
      const dup = [...this.tasks.values()].find(
        (t) => t.item.url === item.url && (t.view.status === 'queued' || t.view.status === 'downloading' || t.view.status === 'resolving'),
      );
      if (dup) {
        skipped.push({ raw: item.raw, reason: `该链接已有进行中的任务 ${dup.view.id}` });
        continue;
      }
      const view = this.enqueue(item);
      created.push(view);
    }
    return { created, skipped };
  }

  private enqueue(item: InputItem): TaskView {
    this.seq += 1;
    const id = `task-${Date.now().toString(36)}-${this.seq}`;
    const view: TaskView = {
      id,
      url: item.url,
      raw: item.raw,
      status: 'queued',
      percent: 0,
      timeSec: 0,
      attempts: 0,
      createdAt: Date.now(),
    };
    this.tasks.set(id, { view, item, controller: new AbortController() });
    this.order.push(id);
    this.queue.push(id);
    this.emit({ type: 'task', task: view });
    queueMicrotask(() => this.pump());
    return view;
  }

  private pump(): void {
    const cfg = this.getConfig();
    const limit = Math.max(1, cfg.concurrency);
    while (this.running < limit && this.queue.length > 0) {
      const id = this.queue.shift();
      if (!id) break;
      const task = this.tasks.get(id);
      if (!task || task.view.status !== 'queued') continue;
      this.running += 1;
      void this.runOne(task)
        .catch((e: unknown) => {
          this.log('error', `任务 ${id} 异常: ${e instanceof Error ? e.message : String(e)}`, id);
        })
        .finally(() => {
          this.running -= 1;
          this.pump();
        });
    }
  }

  private async runOne(task: ManagedTask): Promise<void> {
    const cfg = this.getConfig();
    const settings = toCoreSettings(cfg);
    const total = this.order.length;
    const index = this.order.indexOf(task.view.id) + 1;
    task.view.startedAt = Date.now();

    const workDir = join(this.workRoot, task.view.id);
    // 浏览器通道会把清单/结果文件写进 workDir，必须先建好（ego 侧不会替你建目录）
    mkdirSync(workDir, { recursive: true });
    const pipeline: PipelineOptions = {
      ...settings,
      workDir,
      signal: task.controller.signal,
      onEvent: (e: TaskEvent) => this.handleEvent(task, e),
    };

    const result = await runTask(
      { item: task.item, index: Math.max(1, index), total, taskId: task.view.id },
      pipeline,
    );

    task.result = result;
    task.view.finishedAt = Date.now();
    task.view.title = result.title ?? task.view.title;
    task.view.outputPath = result.filePath ?? task.view.outputPath;
    task.view.fileSize = result.fileSize;
    if (result.status === 'failed') {
      task.view.errorKind = result.errorKind;
      task.view.message = result.message;
      task.view.suggestion = result.suggestion;
      task.view.status = 'failed';
    } else {
      task.view.status = result.status === 'success' ? 'done' : 'skipped';
      if (result.status === 'success') task.view.percent = 100;
    }
    this.emit({ type: 'task', task: task.view });
    this.emit({ type: 'done', taskId: task.view.id, result });
    this.appendHistory(result);
  }

  private handleEvent(task: ManagedTask, e: TaskEvent): void {
    switch (e.type) {
      case 'task':
        task.view.status = e.status;
        if (e.status === 'resolving' && !task.view.startedAt) task.view.startedAt = Date.now();
        this.emit({ type: 'task', task: task.view });
        break;
      case 'progress': {
        const p = e.progress;
        task.view.percent = p.percent;
        task.view.timeSec = p.timeSec;
        // 未提供的字段要清掉，避免沿用上一轮（重试）的旧值
        task.view.bytes = p.bytes;
        task.view.bytesPerSec = p.bytesPerSec;
        task.view.speedX = p.speedX;
        task.view.etaSec = p.etaSec;
        task.view.stalled = p.stalled;
        task.view.segDone = p.segDone;
        task.view.segTotal = p.segTotal;
        this.emit({ type: 'progress', taskId: task.view.id, progress: p });
        break;
      }
      case 'log':
        this.log(e.level, e.message, task.view.id);
        break;
      case 'done':
        this.emit({ type: 'done', taskId: task.view.id, result: e.result });
        break;
      default:
        break;
    }
  }

  list(): TaskView[] {
    return this.order
      .map((id) => this.tasks.get(id)?.view)
      .filter((v): v is TaskView => Boolean(v))
      .reverse();
  }

  get(id: string): TaskView | undefined {
    return this.tasks.get(id)?.view;
  }

  cancel(id: string): boolean {
    const task = this.tasks.get(id);
    if (!task) return false;
    if (task.view.status === 'done' || task.view.status === 'failed' || task.view.status === 'skipped' || task.view.status === 'canceled') {
      return false;
    }
    task.controller.abort();
    task.view.status = 'canceled';
    task.view.errorKind = 'USER_ABORT';
    this.emit({ type: 'task', task: task.view });
    return true;
  }

  /** 重试：把同一输入重新入队（新任务 id，保留历史）。 */
  retry(id: string): TaskView | null {
    const task = this.tasks.get(id);
    if (!task) return null;
    return this.enqueue({ ...task.item, raw: task.item.raw });
  }

  history(): TaskResult[] {
    return [...this.historyItems].reverse();
  }

  failures(): TaskResult[] {
    return this.historyItems.filter((r) => r.status === 'failed');
  }

  stats(): { total: number; success: number; failed: number; skipped: number; running: number; queued: number } {
    const all = [...this.tasks.values()].map((t) => t.view);
    return {
      total: all.length,
      success: all.filter((t) => t.status === 'done').length,
      failed: all.filter((t) => t.status === 'failed').length,
      skipped: all.filter((t) => t.status === 'skipped').length,
      running: all.filter((t) => t.status === 'downloading' || t.status === 'verifying' || t.status === 'resolving' || t.status === 'manifest').length,
      queued: all.filter((t) => t.status === 'queued').length,
    };
  }

  /** 更新配置并广播（GUI 设置页用）；也会触发重新 pump（改并发立即生效）。 */
  updateConfig(patch: Partial<AppConfig>): AppConfig {
    this.setConfig(patch);
    const cfg = this.getConfig();
    this.emit({ type: 'config', config: cfg });
    this.pump();
    return cfg;
  }

  cancelAll(): void {
    for (const id of this.order) this.cancel(id);
  }

  /** 退出清理：删掉本进程的临时工作目录（清单/结果文件），不碰用户下载目录。 */
  dispose(): void {
    try {
      rmSync(this.workRoot, { recursive: true, force: true });
    } catch {
      /* 被占用就留给系统清理 */
    }
  }

  private appendHistory(result: TaskResult): void {
    this.historyItems.push(result);
    if (this.historyItems.length > HISTORY_LIMIT) this.historyItems = this.historyItems.slice(-HISTORY_LIMIT);
    try {
      const file = historyPath();
      writeFileSync(file, `${JSON.stringify(this.historyItems, null, 2)}\n`, 'utf8');
    } catch {
      /* 历史落盘失败不影响任务本身 */
    }
  }
}

function loadHistory(): TaskResult[] {
  try {
    const file = historyPath();
    if (!existsSync(file)) return [];
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as TaskResult[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** 解析预览：只做站点/世代判定（快，不开浏览器）。 */
export async function previewInput(input: string, timeoutSec = 30): Promise<{
  ok: boolean;
  url?: string;
  origin?: string;
  kind?: string;
  pageId?: string;
  generation?: string;
  evidence?: string[];
  error?: { kind: string; message: string; suggestion: string };
}> {
  const items = await normalizeInputs([input], { timeoutMs: timeoutSec * 1000, followShortLinks: true });
  const first = items[0];
  if (!first) {
    const err = new AppError('BAD_INPUT', '未能从输入里提取到链接');
    return { ok: false, error: err.toJSON() };
  }
  const { detectSite } = await import('@acfun/core');
  try {
    const { target, evidence } = await detectSite(first.url, { timeoutMs: timeoutSec * 1000 });
    return {
      ok: true,
      url: target.url,
      origin: target.origin,
      kind: target.kind,
      pageId: target.pageId,
      generation: target.generation,
      evidence,
    };
  } catch (e) {
    return { ok: false, url: first.url, error: classifyError(e, 'PARSE_FAILED').toJSON() };
  }
}
