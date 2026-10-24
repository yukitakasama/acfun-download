/**
 * 并发原语（PLAN §6.5）。
 *
 * 重要语义：**浏览器取清单阶段恒串行**（ego lite 是单实例 + 用户真实 profile，
 * 并行会互抢且更易触发风控）；`--concurrency > 1` 只并行 ffmpeg 下载/核验阶段。
 * 实现方式：任务级并发 + 一把浏览器锁把 resolveOne 串起来。
 */

/** 串行互斥：同一时刻只跑一个 fn，其余排队。 */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn, fn);
    // 不让链条因为某个任务失败而断掉
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

/** 共享的浏览器锁（进程内单例，CLI 与 server 都走它）。 */
export const browserLock = new Mutex();

export interface MapOptions {
  /** 并发度，1 = 串行。 */
  limit?: number;
  /** 每个任务开始前的间隔（毫秒），用于限速。 */
  intervalMs?: number;
  signal?: AbortSignal;
}

/**
 * 有并发上限的 map：结果顺序与输入顺序一致（`{index}` 序号按输入顺序，不是完成顺序）。
 * 不使用 Promise.all 直接并发，避免一次性把几十个任务全塞进去。
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  fn: (item: T, index: number) => Promise<R>,
  opts: MapOptions = {},
): Promise<R[]> {
  const limit = Math.max(1, Math.trunc(opts.limit ?? 1));
  const results = new Array<R>(items.length);
  let cursor = 0;
  let started = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      if (opts.signal?.aborted) return;
      if (started > 0 && opts.intervalMs && opts.intervalMs > 0) {
        await new Promise<void>((r) => setTimeout(r, opts.intervalMs));
      }
      started += 1;
      results[index] = await fn(items[index]!, index);
    }
  };

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}
