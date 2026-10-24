/**
 * ego lite 通道（默认通道）。
 *
 * 驱动方式一律 `ego-browser nodejs`：不开调试端口、不建 --user-data-dir、不自己起 Chrome。
 * 三个必须记住的坑（skill 实测）：
 *   1. ego 运行时不继承 argv 与环境变量 —— 参数只能序列化成字面量注入生成的脚本。
 *   2. ego 的 console 走 **stderr**，stdout 是空的 —— 机器可读结果只经 resultFile 回传。
 *   3. `ego-browser --version` 也打在 stderr —— 只收 stdout 会误判成「没装」。
 */
import { readFileSync, existsSync } from 'node:fs';
import { AppError } from '../errors.js';
import { CAPTURE_ROUND_SOURCE, type CaptureItem, type CaptureRecord } from './capture.js';
import { runProcess } from './spawn.js';

export interface EgoStatus {
  available: boolean;
  version?: string;
  error?: string;
}

export const EGO_CMD = 'ego-browser';

/** 探测 ego lite 是否可用（--version 有输出即可用；输出在 stderr）。 */
export async function egoStatus(egoPath: string = EGO_CMD, timeoutMs = 15_000): Promise<EgoStatus> {
  const r = await runProcess(egoPath, ['--version'], { timeoutMs });
  const output = `${r.stderr}${r.stdout}`.trim();
  if (r.code === null && !output) {
    return { available: false, error: `无法执行 ${egoPath}（未安装或不在 PATH）` };
  }
  if (!output) {
    return { available: false, error: `${egoPath} --version 无输出，ego lite 可能未运行` };
  }
  return { available: true, version: output.split(/\r?\n/)[0]?.trim() };
}

export interface EgoCaptureOptions {
  generation: 'nuxt' | 'vite';
  items: CaptureItem[];
  resultFile: string;
  spaceName: string;
  captureTimeoutMs?: number;
  fetchTimeoutMs?: number;
  egoPath?: string;
  /** 整体超时（毫秒）。默认按条目数线性放大。 */
  timeoutMs?: number;
  /** 注入跑脚本的函数，便于单测。 */
  executor?: (script: string, timeoutMs: number) => Promise<{ code: number | null; stdout: string; stderr: string }>;
}

/**
 * 生成注入 ego 的脚本。
 *
 * 结构：captureRound 的函数源码（toString 得来，自包含）+ 一个自执行托盘：
 *   - 建任务空间、拿 p1 页、把 page 塞进 opts
 *   - 跑一轮捕获
 *   - 任何异常都补写一条 fatal 结果（否则 Node 侧只能看到「没产出结果文件」）
 *   - 最后 `task.finish({ keep: [] })` 收掉标签页，不在用户窗口留残页
 */
export function buildEgoScript(opts: EgoCaptureOptions): string {
  const payload = {
    generation: opts.generation,
    items: opts.items,
    resultFile: opts.resultFile,
    captureTimeoutMs: opts.captureTimeoutMs,
    fetchTimeoutMs: opts.fetchTimeoutMs,
  };

  // 兜底：万一打包器往函数体里注入了 `__name(...)` 这类 helper（esbuild 的 keepNames），
  // 就在脚本顶部补一个同名恒等实现，避免注入 ego 后报「__name is not defined」。
  const needsShim = /\b__name\(/.test(CAPTURE_ROUND_SOURCE) && !/const __name\s*=/.test(CAPTURE_ROUND_SOURCE);
  const shim = needsShim ? ['const __name = (fn) => fn;', ''].join('\n') : '';

  const head = [shim + CAPTURE_ROUND_SOURCE, ''].join('\n');
  const tail = [
    `const __acfunOpts = ${JSON.stringify(payload, null, 1)};`,
    `const __acfunSpace = ${JSON.stringify(opts.spaceName)};`,
    '',
    '(async () => {',
    '  let task = null;',
    '  try {',
    '    task = await taskSpace(__acfunSpace);',
    "    __acfunOpts.page = task.page('p1');",
    '    await captureRound(__acfunOpts);',
    '  } catch (e) {',
    '    try {',
    "      const fs = await import('node:fs/promises');",
    '      const first = (__acfunOpts.items && __acfunOpts.items[0]) || {};',
    '      await fs.writeFile(',
    '        __acfunOpts.resultFile,',
    '        JSON.stringify([{ id: first.id || "", url: first.url || "", ok: false, fatal: true,',
    '          error: String((e && e.message) || e) }], null, 1),',
    "        'utf8',",
    '      );',
    '    } catch (e2) { /* 连结果文件都写不了就只能靠 stderr 了 */ }',
    '  } finally {',
    '    if (task) {',
    '      try { await task.finish({ keep: [] }); } catch (e3) { /* 收尾失败不影响结果 */ }',
    '    }',
    '  }',
    '})();',
    '',
  ].join('\n');

  return head + tail;
}

/** 跑一轮 ego 取清单，返回逐条结果。 */
export async function runEgoCapture(opts: EgoCaptureOptions): Promise<CaptureRecord[]> {
  const script = buildEgoScript(opts);
  const timeoutMs = opts.timeoutMs ?? 180_000 + opts.items.length * 90_000;
  const executor =
    opts.executor ??
    ((src: string, t: number) => runProcess(opts.egoPath ?? EGO_CMD, ['nodejs'], { input: src, timeoutMs: t }));

  const r = await executor(script, timeoutMs);

  if (existsSync(opts.resultFile)) {
    try {
      const parsed = JSON.parse(readFileSync(opts.resultFile, 'utf8')) as CaptureRecord[];
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    } catch {
      /* 落到下面统一报错 */
    }
  }

  const logTail = `${r.stderr}${r.stdout}`
    .trim()
    .split(/\r?\n/)
    .slice(-15)
    .join('\n');
  throw new AppError('BROWSER_UNAVAILABLE', `ego 轮次未产出结果文件（exit=${r.code}）。ego lite 可能未运行，或页面未能起播。`, {
    detail: logTail,
  });
}
