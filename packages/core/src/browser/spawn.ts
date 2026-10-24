/**
 * 子进程小工具：异步 spawn（不阻塞事件循环，server 里也能用）+ 超时。
 */
import { spawn } from 'node:child_process';

export interface SpawnResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface SpawnOptions {
  input?: string;
  timeoutMs?: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** 继承 stdio 直接透传（给 ffmpeg 用）。 */
  inheritStdio?: boolean;
  signal?: AbortSignal;
}

export function runProcess(cmd: string, args: readonly string[], opts: SpawnOptions = {}): Promise<SpawnResult> {
  return new Promise<SpawnResult>((resolve) => {
    let timedOut = false;
    const child = spawn(cmd, [...args], {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      windowsHide: true,
      stdio: opts.inheritStdio ? ['ignore', 'inherit', 'inherit'] : ['pipe', 'pipe', 'pipe'],
    });

    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout?.on('data', (c: Buffer) => out.push(Buffer.from(c)));
    child.stderr?.on('data', (c: Buffer) => err.push(Buffer.from(c)));

    const timer =
      opts.timeoutMs && opts.timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            try {
              child.kill('SIGKILL');
            } catch {
              /* ignore */
            }
          }, opts.timeoutMs)
        : null;

    const onAbort = (): void => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    child.on('error', (e) => {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      resolve({
        code: null,
        signal: null,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: `${Buffer.concat(err).toString('utf8')}${e.message}`,
        timedOut,
      });
    });

    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      resolve({
        code,
        signal,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        timedOut,
      });
    });

    if (opts.input !== undefined && child.stdin) {
      child.stdin.end(opts.input);
    }
  });
}
