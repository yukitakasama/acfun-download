import { describe, expect, it } from 'vitest';
import { browserLock, mapWithConcurrency, Mutex } from '../src/index.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('Mutex（浏览器阶段恒串行）', () => {
  it('同一时刻只跑一个 fn', async () => {
    const lock = new Mutex();
    let running = 0;
    let maxRunning = 0;
    const order: number[] = [];
    const jobs = [0, 1, 2, 3, 4].map((i) =>
      lock.run(async () => {
        running += 1;
        maxRunning = Math.max(maxRunning, running);
        await sleep(5);
        order.push(i);
        running -= 1;
        return i;
      }),
    );
    const results = await Promise.all(jobs);
    expect(maxRunning).toBe(1);
    expect(results).toEqual([0, 1, 2, 3, 4]);
    expect(order).toEqual([0, 1, 2, 3, 4]);
  });

  it('某个任务抛错不会卡死后续任务', async () => {
    const lock = new Mutex();
    const bad = lock.run(async () => {
      throw new Error('boom');
    });
    await expect(bad).rejects.toThrow('boom');
    await expect(lock.run(async () => 'ok')).resolves.toBe('ok');
  });

  it('共享的 browserLock 是同一个实例', async () => {
    expect(browserLock).toBeInstanceOf(Mutex);
  });
});

describe('mapWithConcurrency', () => {
  it('并发上限被遵守', async () => {
    let running = 0;
    let maxRunning = 0;
    const items = Array.from({ length: 8 }, (_, i) => i);
    const out = await mapWithConcurrency(
      items,
      async (i) => {
        running += 1;
        maxRunning = Math.max(maxRunning, running);
        await sleep(10);
        running -= 1;
        return i * 2;
      },
      { limit: 3 },
    );
    expect(maxRunning).toBeLessThanOrEqual(3);
    expect(maxRunning).toBeGreaterThan(1);
    // 结果顺序与输入顺序一致（{index} 按输入顺序，不按完成顺序）
    expect(out).toEqual(items.map((i) => i * 2));
  });

  it('limit=1 时串行执行', async () => {
    let running = 0;
    let maxRunning = 0;
    await mapWithConcurrency(
      [1, 2, 3],
      async () => {
        running += 1;
        maxRunning = Math.max(maxRunning, running);
        await sleep(3);
        running -= 1;
      },
      { limit: 1 },
    );
    expect(maxRunning).toBe(1);
  });

  it('任务开始前有 interval 间隔（限速）', async () => {
    const starts: number[] = [];
    await mapWithConcurrency(
      [1, 2, 3],
      async () => {
        starts.push(Date.now());
      },
      { limit: 1, intervalMs: 40 },
    );
    expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(35);
    expect(starts[2]! - starts[1]!).toBeGreaterThanOrEqual(35);
  });

  it('abort 后不再启动新任务', async () => {
    const controller = new AbortController();
    const started: number[] = [];
    const out = await mapWithConcurrency(
      [1, 2, 3, 4],
      async (i) => {
        started.push(i);
        if (i === 1) controller.abort();
        return i;
      },
      { limit: 1, signal: controller.signal },
    );
    expect(started).toEqual([1]);
    expect(out[1]).toBeUndefined();
  });
});
