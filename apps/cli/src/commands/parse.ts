/**
 * `acfun parse` —— 只解析，不下载（PLAN M1/M3 的验收命令）。
 *
 * M1：输出 origin / kind / pageId / generation（世代靠裸 HTML 特征判定，不开浏览器）。
 * M3：追加清单信息（segments / durationSec / bandwidth / channel）。
 * 需鉴权内容返回 AUTH_REQUIRED 且**不产出任何文件**（清单只落临时目录，结束即删）。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppError, classifyError, detectSite, resolveOne, type InputItem } from '@acfun/core';
import type { CliOptions } from '../args.js';
import { collectInputs, CliLog } from '../io.js';

export interface ParseRecord {
  ok: boolean;
  input: string;
  url: string;
  origin?: string;
  kind?: string;
  pageId?: string;
  generation?: string;
  evidence?: string[];
  title?: string;
  /** 清单信息（M3 起）。 */
  channel?: string;
  segments?: number;
  durationSec?: number;
  bandwidth?: number;
  hasEndlist?: boolean;
  playlistUrl?: string;
  warn?: string[];
  error?: { kind: string; message: string; suggestion: string };
}

export async function runParse(positionals: readonly string[], opts: CliOptions, log: CliLog): Promise<number> {
  let items: InputItem[];
  try {
    items = await collectInputs(positionals, opts);
  } catch (e) {
    const err = classifyError(e, 'BAD_INPUT');
    reportError(err, log, opts);
    return 1;
  }
  if (items.length === 0) {
    log.error('没有可解析的输入。给一个 URL 或分享文本，或用 -f urls.txt / stdin。');
    return 1;
  }

  const workDir = mkdtempSync(join(tmpdir(), 'acfun-parse-'));
  let failed = 0;
  try {
    for (const item of items) {
      let rec: ParseRecord;
      const warns: string[] = [];
      try {
        const { target, evidence } = await detectSite(item.url, { timeoutMs: opts.timeoutSec * 1000 });
        rec = {
          ok: true,
          input: item.raw,
          url: target.url,
          origin: target.origin,
          kind: target.kind,
          pageId: target.pageId,
          generation: target.generation,
          evidence,
        };
        // M3：真正取一次清单（同时验证安全边界）
        const resolved = await resolveOne(item, {
          channel: opts.channel ?? 'auto',
          workDir,
          timeoutSec: opts.timeoutSec,
          log: (m) => log.debug(m),
          warn: (m) => {
            warns.push(m);
            log.warn(m);
          },
          ...(opts.proxy === undefined ? {} : { proxy: opts.proxy }),
          ...(opts.cookie === undefined ? {} : { cookieFile: opts.cookie }),
          ...(opts.chrome === undefined ? {} : { chromePath: opts.chrome }),
        });
        rec.channel = resolved.channel;
        rec.title = resolved.meta.title;
        rec.segments = resolved.manifest.segments;
        rec.durationSec = Number(resolved.manifest.durationSec.toFixed(3));
        rec.hasEndlist = resolved.manifest.hasEndlist;
        rec.playlistUrl = resolved.manifest.playlistUrl;
        if (resolved.manifest.variantBandwidth !== undefined) rec.bandwidth = resolved.manifest.variantBandwidth;
        if (resolved.warn) warns.push(resolved.warn);
      } catch (e) {
        const err = classifyError(e, 'PARSE_FAILED');
        failed++;
        rec = {
          ok: false,
          input: item.raw,
          url: item.url,
          error: { kind: err.kind, message: err.message, suggestion: err.suggestion },
        };
        if (e instanceof AppError) log.debug(`detail: ${JSON.stringify(e.detail)}`);
      }
      if (warns.length > 0) rec.warn = warns;

      if (opts.json) log.emit(rec);
      else process.stdout.write(`${JSON.stringify(rec, null, 2)}\n`);
      if (!rec.ok) log.error(`[${rec.url}] ${rec.error?.kind}: ${rec.error?.message}\n  建议: ${rec.error?.suggestion}`);
    }
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }

  return failed > 0 ? 3 : 0;
}

export function reportError(err: AppError, log: CliLog, opts: CliOptions): void {
  if (opts.json) log.emit({ ok: false, error: err.toJSON() });
  log.error(`${err.kind}: ${err.message}`);
  log.error(`建议: ${err.suggestion}`);
}
