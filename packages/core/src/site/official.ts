/**
 * 官方站（www.acfun.cn）尽力解析（PLAN §4.4）。
 *
 * 只做一次低成本尝试：抓页面 HTML / 内联状态，找 HLS/DASH 清单；取不到就明确
 * 报 OFFICIAL_UNSUPPORTED，**不产出空文件、不静默失败**。此分支在 README 标注为实验性。
 */
import { AppError } from '../errors.js';
import { httpText, type FetchLike } from '../net.js';
import type { ParsedTarget } from '../types.js';

export interface OfficialAttemptOptions {
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

export interface OfficialAttemptResult {
  playlistUrl: string;
  text: string;
  /** 线索来源，便于报告说明「怎么找到的」。 */
  evidence: string;
}

const M3U8_RE = /https?:\/\/[^\s"'<>\\]+?\.m3u8[^\s"'<>\\]*/gi;
/** 内联状态里常见的播放地址字段名。 */
const STATE_FIELD_RE = /"(?:playUrl|videoUrl|m3u8|hlsUrl|src)"\s*:\s*"([^"]+\.m3u8[^"]*)"/gi;

/** 从 HTML / 内联 JSON 里收集候选清单地址（去重、保序）。 */
export function extractPlaylistCandidates(html: string): string[] {
  const out: string[] = [];
  const push = (u: string): void => {
    const cleaned = u.replace(/\\\//g, '/').replace(/\\u0026/g, '&');
    if (!/^https?:\/\//.test(cleaned)) return;
    if (!out.includes(cleaned)) out.push(cleaned);
  };
  for (const m of html.matchAll(M3U8_RE)) push(m[0]);
  for (const m of html.matchAll(STATE_FIELD_RE)) if (m[1]) push(m[1]);
  return out;
}

/**
 * 尝试解析官方站。返回 null 表示「没有可用线索」（调用方报 OFFICIAL_UNSUPPORTED）。
 * 注意：这不是完整适配——官方站需要另做逆向，本工具只做公开清单的顺带尝试。
 */
export async function tryOfficialPlaylist(
  target: ParsedTarget,
  opts: OfficialAttemptOptions = {},
): Promise<OfficialAttemptResult | null> {
  let html: string;
  try {
    const res = await httpText(target.url, { timeoutMs: opts.timeoutMs ?? 30_000, fetchImpl: opts.fetchImpl });
    if (!res.ok) return null;
    html = res.text;
  } catch {
    return null;
  }

  const candidates = extractPlaylistCandidates(html);
  for (const url of candidates) {
    try {
      const res = await httpText(url, {
        timeoutMs: opts.timeoutMs ?? 30_000,
        fetchImpl: opts.fetchImpl,
        headers: { referer: target.url, accept: '*/*' },
      });
      if (res.ok && /^#EXTM3U/m.test(res.text)) {
        return { playlistUrl: url, text: res.text, evidence: 'page-inline-m3u8' };
      }
    } catch {
      /* 换下一个候选 */
    }
  }
  return null;
}

/** 统一的 OFFICIAL_UNSUPPORTED 错误。 */
export function officialUnsupported(target: ParsedTarget): AppError {
  return new AppError(
    'OFFICIAL_UNSUPPORTED',
    `官方站页面里没有可直接使用的 HLS 清单（需要登录/前端加密或另有接口）: ${target.url}`,
    { suggestion: '官方站（www.acfun.cn）需另做逆向适配，本次未实现；可改用马甲域链接。' },
  );
}
