/**
 * CLI 侧 IO：日志通道 + 输入收集。
 *
 * 约定：人类可读日志一律走 stderr，stdout 只放机器可读结果（`--json` 的 NDJSON / parse 的 JSON）。
 * 这样 `acfun parse <url> --json | jq` 永远干净。
 */
import {
  dedupeKey,
  normalizeInputs,
  readInputsFromFile,
  readInputsFromStdin,
  type InputItem,
} from '@acfun/core';
import type { CliOptions } from './args.js';

export class CliLog {
  constructor(private readonly cfg: { json: boolean; verbose: boolean }) {}

  info(msg: string): void {
    process.stderr.write(`${msg}\n`);
  }

  warn(msg: string): void {
    process.stderr.write(`警告: ${msg}\n`);
  }

  error(msg: string): void {
    process.stderr.write(`错误: ${msg}\n`);
  }

  debug(msg: string): void {
    if (this.cfg.verbose) process.stderr.write(`[debug] ${msg}\n`);
  }

  get jsonMode(): boolean {
    return this.cfg.json;
  }

  /** 机器可读事件（stdout，NDJSON）。 */
  emit(obj: unknown): void {
    process.stdout.write(`${JSON.stringify(obj)}\n`);
  }
}

/**
 * 收集全部输入：位置参数 + `-f 文件` + stdin（位置参数里的 `-` 或 `--file -`）。
 * 各来源之间再按 origin+path 兜底去重（保留首次出现）。
 */
export async function collectInputs(positionals: readonly string[], opts: CliOptions): Promise<InputItem[]> {
  const items: InputItem[] = [];
  const fromArgs: string[] = [];
  let wantStdin = false;

  for (const p of positionals) {
    if (p === '-') wantStdin = true;
    else fromArgs.push(p);
  }
  const fileArg = opts.file;
  if (fileArg === '-') wantStdin = true;

  const normalizeOpts = { origin: opts.origin, timeoutMs: opts.timeoutSec * 1000 };

  if (fromArgs.length > 0) items.push(...(await normalizeInputs(fromArgs, normalizeOpts)));
  if (fileArg && fileArg !== '-') items.push(...(await readInputsFromFile(fileArg, normalizeOpts)));
  if (wantStdin) items.push(...(await readInputsFromStdin(normalizeOpts)));

  const seen = new Set<string>();
  const deduped: InputItem[] = [];
  for (const item of items) {
    const key = dedupeKey(item.url);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
  }
  return deduped;
}

/** 输入在报告里的定位串，例如 `urls.txt:12` 或 `#2`。 */
export function describeItem(item: InputItem, index: number): string {
  if (item.source === 'file' && item.line) return `${item.line} 行`;
  if (item.source === 'stdin') return item.line ? `stdin:${item.line}` : 'stdin';
  return `#${index + 1}`;
}
