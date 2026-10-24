/**
 * 把「一条输入」解析成「可下载的视频 + 已落盘的清单」（PLAN §4.2–§4.5）。
 *
 * 流程：判定世代 → 选通道取清单（ego lite 优先，Chrome/CDP 兜底）→ 绝对化清单里的相对 URI
 *      → 解析段数/时长/码率 → 过安全边界 → 回传 ResolvedVideo。
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AppError, classifyError } from './errors.js';
import { EGO_CMD, egoStatus, runEgoCapture } from './browser/ego.js';
import { runChromeCapture } from './browser/chrome.js';
import type { CaptureRecord } from './browser/capture.js';
import {
  absolutizeUris,
  earliestExpiry,
  isHlsManifest,
  parsePlaylist,
  type ParsedPlaylist,
} from './manifest/index.js';
import { cleanPageTitle, detectSite, looksLikeErrorTitle } from './site/index.js';
import { officialUnsupported, tryOfficialPlaylist } from './site/official.js';
import type { Generation, InputItem, Manifest, ParsedTarget, VideoMeta } from './types.js';

export type BrowserChannel = 'auto' | 'ego' | 'chrome';

export interface ResolveOptions {
  /** 期望的浏览器通道。 */
  channel?: BrowserChannel;
  egoPath?: string;
  chromePath?: string;
  proxy?: string;
  cookieFile?: string;
  timeoutSec?: number;
  captureTimeoutMs?: number;
  fetchTimeoutMs?: number;
  /** 清单临时目录（放 .m3u8）。 */
  workDir: string;
  log?: (msg: string) => void;
  warn?: (msg: string) => void;
  /** 注入 ego 执行器（单测用）。 */
  egoExecutor?: (script: string, timeoutMs: number) => Promise<{ code: number | null; stdout: string; stderr: string }>;
}

export interface ResolvedVideo {
  target: ParsedTarget;
  meta: VideoMeta;
  manifest: Manifest;
  /** 已绝对化、可直接交给 ffmpeg 的本地清单路径。 */
  manifestPath: string;
  channel: 'ego' | 'chrome' | 'official';
  warn?: string;
  record: CaptureRecord;
}

function log(opts: ResolveOptions, msg: string): void {
  opts.log?.(msg);
}

/** 选择浏览器通道：auto 时 ego 优先，ego 不可用再回落到 Chrome。 */
export async function pickChannel(opts: ResolveOptions): Promise<'ego' | 'chrome'> {
  const explicit = opts.channel ?? 'auto';
  if (explicit === 'chrome') return 'chrome';
  if (explicit === 'ego') return 'ego';
  const status = await egoStatus(opts.egoPath ?? EGO_CMD);
  if (status.available) return 'ego';
  opts.warn?.(`ego lite 不可用（${status.error ?? '未知原因'}），回落到 Chrome + CDP 通道`);
  return 'chrome';
}

/** 把浏览器通道的错误码映射成分类错误（带建议）。 */
export function errorFromRecord(rec: CaptureRecord): AppError {
  const code = rec.errorCode ?? '';
  const message = rec.error ?? '取清单失败（浏览器通道没有给出原因）';
  switch (code) {
    case 'AUTH_PATH_NOT_CAPTURED':
      return new AppError('AUTH_REQUIRED', message, {
        suggestion: '该内容需要登录或购买才能取到清单，本工具不做绕过；换公开内容，或用带登录态的 ego lite 通道。',
      });
    case 'AUTH_REQUIRED':
      return new AppError('AUTH_REQUIRED', message, {
        suggestion: rec.previewOnly
          ? '该内容只提供预览（previewUrl），按安全边界停止，不下载预览冒充正片。'
          : '该内容需要登录或购买才能播放，本工具不做绕过。',
      });
    case 'NOT_HLS':
      return new AppError('MANIFEST_NOT_HLS', message);
    case 'MANIFEST_HTTP': {
      const kind = /status=403/.test(message) ? 'HTTP_403' : /status=404/.test(message) ? 'HTTP_404' : 'PARSE_FAILED';
      return new AppError(kind, message);
    }
    case 'AUT_NOT_CAPTURED':
      return new AppError('PARSE_FAILED', message, {
        suggestion: '世代判定可能错了：Nuxt 世代不会发 aut 头。重跑一次，或检查页面是否被换成新版本。',
      });
    case 'DETAIL_FAILED':
      return new AppError('PARSE_FAILED', message, {
        suggestion: '详情接口失败：多为签名/授权头抓取不完整或签名过期，重跑一轮。',
      });
    default:
      return new AppError('PARSE_FAILED', message);
  }
}

/** 清单临时文件路径。 */
export function manifestPathFor(workDir: string, id: string): string {
  const safe = id.replace(/[^\w.-]/g, '_');
  return join(workDir, `acfun-${safe}.m3u8`);
}

interface CaptureOnceOptions extends ResolveOptions {
  generation: Exclude<Generation, 'official' | 'unknown'>;
  target: ParsedTarget;
  item: InputItem;
}

/** 跑一轮取清单（ego 或 chrome），返回该条结果。 */
async function captureOnce(o: CaptureOnceOptions): Promise<{ channel: 'ego' | 'chrome'; rec: CaptureRecord; manifestFile: string }> {
  const channel = await pickChannel(o);
  const manifestFile = manifestPathFor(o.workDir, o.target.pageId);
  const resultFile = join(o.workDir, `result-${o.target.pageId}-${Date.now().toString(36)}.json`);
  const items = [{ id: o.target.pageId, url: o.target.url, manifestFile }];

  if (channel === 'ego' && (o.proxy ?? '').trim()) {
    o.warn?.('ego lite 通道不支持 --proxy，本次回落到 Chrome 通道');
    return captureOnce({ ...o, channel: 'chrome' });
  }

  if (channel === 'chrome') {
    o.warn?.('当前使用 Chrome + CDP 兜底通道；推荐优先用 ego lite（用户真实 profile、更少风控、天然带登录态）');
  }
  log(o, `通道: ${channel === 'ego' ? 'ego lite' : 'Chrome+CDP'}；世代: ${o.generation}`);

  const records =
    channel === 'ego'
      ? await runEgoCapture({
          generation: o.generation,
          items,
          resultFile,
          spaceName: `acfun-${o.generation}-${Date.now().toString(36)}`,
          ...(o.captureTimeoutMs === undefined ? {} : { captureTimeoutMs: o.captureTimeoutMs }),
          ...(o.fetchTimeoutMs === undefined ? {} : { fetchTimeoutMs: o.fetchTimeoutMs }),
          ...(o.egoPath === undefined ? {} : { egoPath: o.egoPath }),
          ...(o.egoExecutor === undefined ? {} : { executor: o.egoExecutor }),
        })
      : await runChromeCapture({
          generation: o.generation,
          items,
          resultFile,
          ...(o.chromePath === undefined ? {} : { chromePath: o.chromePath }),
          ...(o.proxy === undefined ? {} : { proxy: o.proxy }),
          ...(o.cookieFile === undefined ? {} : { cookieFile: o.cookieFile }),
          ...(o.captureTimeoutMs === undefined ? {} : { captureTimeoutMs: o.captureTimeoutMs }),
          ...(o.fetchTimeoutMs === undefined ? {} : { fetchTimeoutMs: o.fetchTimeoutMs }),
        });

  const rec = records.find((r) => String(r.id) === String(o.target.pageId)) ?? records[0];
  if (!rec) {
    throw new AppError('PARSE_FAILED', '浏览器通道没有返回该条结果');
  }
  if (rec.fatal) {
    throw new AppError('BROWSER_UNAVAILABLE', rec.error ?? '浏览器通道整轮失败', {
      detail: rec.error,
    });
  }
  return { channel, rec, manifestFile };
}

/**
 * 解析单条输入。
 *
 * 安全边界（硬编码，不可配置关闭）：
 *   - Vite：`canWatch === true` 才继续；
 *   - Nuxt：authPath 为 public 且返回 `#EXTM3U` 才继续；
 *   - 只拿到 previewUrl → 停止；需登录/购买 → 停止；
 *   - 页面标题是错误页（站点对无效 id 会回退播别的内容）→ 停止，避免交付错视频。
 */
export async function resolveOne(item: InputItem, opts: ResolveOptions): Promise<ResolvedVideo> {
  const { target } = await detectSite(item.url, { timeoutMs: (opts.timeoutSec ?? 30) * 1000 });

  if (target.generation === 'unknown') {
    throw new AppError('SITE_UNKNOWN', `无法判定世代: ${target.url}`);
  }

  // ---- 官方站：尽力解析 ----
  if (target.generation === 'official') {
    const attempt = await tryOfficialPlaylist(target, { timeoutMs: (opts.timeoutSec ?? 30) * 1000 });
    if (!attempt) throw officialUnsupported(target);
    const text = absolutizeUris(attempt.text, attempt.playlistUrl);
    const manifestPath = manifestPathFor(opts.workDir, target.pageId);
    writeFileSync(manifestPath, text, 'utf8');
    const parsed = parsePlaylist(text, { baseUrl: attempt.playlistUrl });
    const record: CaptureRecord = {
      id: target.pageId,
      url: target.url,
      ok: true,
      playlistUrl: attempt.playlistUrl,
      rawTitle: '',
    };
    return {
      target,
      meta: {
        videoId: target.pageId,
        title: cleanPageTitle(record.rawTitle ?? '') || `acfun-${target.pageId}`,
        author: '',
        pageUrl: target.url,
        generation: 'official',
        ...(parsed.durationSec > 0 ? { durationSec: parsed.durationSec } : {}),
      },
      manifest: toManifest(attempt.playlistUrl, text, parsed),
      manifestPath,
      channel: 'official',
      warn: '官方站为实验性支持，未做完整适配',
      record,
    };
  }

  // ---- 马甲域：两代前端 ----
  const generation = target.generation as 'nuxt' | 'vite';
  const { channel, rec, manifestFile } = await captureOnce({ ...opts, generation, target, item });

  // 页面标题是错误页 → 站点很可能为该内容回退了别的视频，停止交付。
  const rawTitle = rec.rawTitle ?? rec.detailTitle ?? '';
  if (looksLikeErrorTitle(rawTitle)) {
    throw new AppError('PAGE_ERROR_TITLE', `页面标题是错误页（「${rawTitle}」），疑似站点回退播放了别的内容`, {
      detail: rec,
    });
  }

  if (!rec.ok) throw errorFromRecord(rec);

  // 读回清单（浏览器侧写的），绝对化后落盘交给 ffmpeg。
  const { readFileSync } = await import('node:fs');
  const raw = readFileSync(manifestFile, 'utf8');
  if (!isHlsManifest(raw)) throw new AppError('MANIFEST_NOT_HLS', '清单缺少 #EXTM3U');

  const baseUrl = rec.playlistUrl
    ? /^https?:\/\//.test(rec.playlistUrl)
      ? rec.playlistUrl
      : new URL(rec.playlistUrl, target.origin).href
    : target.url;
  const text = absolutizeUris(raw, baseUrl);
  writeFileSync(manifestFile, text, 'utf8');
  const parsed = parsePlaylist(text, { baseUrl });

  if (parsed.segments === 0) {
    throw new AppError('MANIFEST_NOT_HLS', '清单里没有任何分片（#EXTINF 为 0）');
  }

  const title = cleanPageTitle(rec.detailTitle || rec.rawTitle || '') || `acfun-${target.pageId}`;
  const meta: VideoMeta = {
    // 社区帖的 URL id 是动态 id，不是视频 id；命名沿用页面 id（与 skill 的 <帖子id>_<标题> 一致）。
    videoId: target.pageId,
    title,
    author: '',
    pageUrl: target.url,
    generation: target.generation,
    durationSec: rec.detailDuration ?? parsed.durationSec,
  };

  const manifest = toManifest(baseUrl, text, parsed);
  if (rec.variantBandwidth) manifest.variantBandwidth = rec.variantBandwidth;

  return {
    target,
    meta,
    manifest,
    manifestPath: manifestFile,
    channel,
    ...(rec.warn === undefined ? {} : { warn: rec.warn }),
    record: rec,
  };
}

function toManifest(playlistUrl: string, text: string, parsed: ParsedPlaylist): Manifest {
  const keyExpireAt = earliestExpiry(parsed, playlistUrl);
  return {
    playlistUrl,
    text,
    segments: parsed.segments,
    durationSec: parsed.durationSec,
    hasEndlist: parsed.hasEndlist,
    ...(keyExpireAt === undefined ? {} : { keyExpireAt }),
  };
}

/** 把 resolveOne 的异常统一转成 AppError（不吞异常，只补分类）。 */
export function asAppError(e: unknown): AppError {
  return classifyError(e, 'PARSE_FAILED');
}
