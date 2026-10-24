/**
 * 附加资源（PLAN Q7）：元数据 sidecar（默认开）、封面（默认开）、弹幕/字幕（默认关，实验性）。
 *
 * 原则：附加资源失败**只告警不阻塞主流程**——主体视频核验通过就要交付。
 */
import { writeFileSync } from 'node:fs';
import { httpText, type FetchLike } from '../net.js';
import { sidecarPath } from '../naming/index.js';
import type { Generation, VideoMeta } from '../types.js';

export interface AssetContext {
  dir: string;
  baseName: string;
  meta: VideoMeta;
  pageUrl: string;
  generation: Generation;
  manifestDurationSec: number;
  segments: number;
  variantBandwidth?: number;
  /** 核验数据（写进 sidecar，便于事后核对）。 */
  verified?: { frames: number; durationSec: number; manifestDurationSec: number };
  fileSize?: number;
}

export interface AssetOptions {
  meta: boolean;
  cover: boolean;
  danmaku: boolean;
  subtitle: boolean;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

export interface AssetOutcome {
  metaFile?: string;
  coverFile?: string;
  danmakuFile?: string;
  subtitleFile?: string;
  warnings: string[];
}

/** 从页面 HTML 里取 `og:image`（封面地址）。取不到返回 undefined，不打网络错误。 */
export function extractCoverUrl(html: string): string | undefined {
  const patterns = [
    /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i,
    /<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i,
  ];
  for (const re of patterns) {
    const m = re.exec(html);
    if (m?.[1]) return m[1].trim();
  }
  return undefined;
}

/** 封面后缀推断（站点多是 jpg/webp；未知一律 .jpg）。 */
export function coverExtFromUrl(url: string): string {
  const m = /\.(jpe?g|png|webp|avif)(?:\?|$)/i.exec(url);
  if (!m?.[1]) return '.jpg';
  const ext = m[1].toLowerCase();
  return ext === 'jpeg' ? '.jpg' : `.${ext}`;
}

/**
 * 写附加资源。**永不抛异常**：所有问题都变成 warnings。
 */
export async function writeAssets(ctx: AssetContext, opts: AssetOptions): Promise<AssetOutcome> {
  const warnings: string[] = [];
  const outcome: AssetOutcome = { warnings };
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as FetchLike);
  const timeoutMs = opts.timeoutMs ?? 20_000;

  // ---- 元数据 sidecar ----
  if (opts.meta) {
    const file = sidecarPath(ctx.dir, ctx.baseName, '.meta.json');
    const payload = {
      title: ctx.meta.title,
      videoId: ctx.meta.videoId,
      author: ctx.meta.author,
      authorId: ctx.meta.authorId ?? null,
      publishTime: ctx.meta.publishTime ?? null,
      pageUrl: ctx.pageUrl,
      generation: ctx.generation,
      durationSec: ctx.meta.durationSec ?? null,
      manifest: {
        segments: ctx.segments,
        durationSec: ctx.manifestDurationSec,
        variantBandwidth: ctx.variantBandwidth ?? null,
      },
      verified: ctx.verified ?? null,
      fileSize: ctx.fileSize ?? null,
      downloadedAt: new Date().toISOString(),
    };
    try {
      writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
      outcome.metaFile = file;
    } catch (e) {
      warnings.push(`写元数据失败: ${(e as Error).message}`);
    }
  }

  // ---- 封面 ----
  if (opts.cover) {
    try {
      const coverUrl = ctx.meta.coverUrl ?? (await coverFromPage(ctx.pageUrl, fetchImpl, timeoutMs));
      if (!coverUrl) {
        warnings.push('未能从页面拿到封面（og:image），跳过封面下载');
      } else {
        const res = await fetchImpl(coverUrl, {
          headers: { 'user-agent': 'Mozilla/5.0', referer: ctx.pageUrl, accept: 'image/*' },
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok) {
          warnings.push(`封面下载失败: HTTP ${res.status}`);
        } else {
          const buf = Buffer.from(await res.arrayBuffer());
          if (buf.length === 0) {
            warnings.push('封面下载失败: 0 字节');
          } else {
            const file = sidecarPath(ctx.dir, ctx.baseName, coverExtFromUrl(coverUrl));
            writeFileSync(file, buf);
            outcome.coverFile = file;
          }
        }
      }
    } catch (e) {
      warnings.push(`封面下载异常: ${(e as Error).message}`);
    }
  }

  // ---- 弹幕 / 字幕（实验性，默认关）----
  if (opts.danmaku) {
    warnings.push('弹幕：两代前端均未发现稳定的公开弹幕接口（实验性，本版未实现，仅告警）');
  }
  if (opts.subtitle) {
    warnings.push('字幕：站点通常不提供字幕轨（实验性，本版未实现，仅告警）');
  }

  return outcome;
}

/** 抓页面拿 og:image。失败返回 undefined。 */
export async function coverFromPage(
  pageUrl: string,
  fetchImpl: FetchLike,
  timeoutMs: number,
): Promise<string | undefined> {
  try {
    const res = await httpText(pageUrl, {
      fetchImpl,
      timeoutMs,
      headers: { accept: 'text/html,*/*' },
    });
    if (!res.ok) return undefined;
    const url = extractCoverUrl(res.text);
    if (!url) return undefined;
    try {
      return new URL(url, pageUrl).href;
    } catch {
      return undefined;
    }
  } catch {
    return undefined;
  }
}
