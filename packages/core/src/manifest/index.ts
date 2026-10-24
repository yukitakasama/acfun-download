/**
 * HLS 清单解析（PLAN §4.3 第 5 步）。
 *
 * 只做纯文本处理，不发请求 —— 方便单测。取清单（浏览器通道）在 `src/browser` 里。
 *
 * 关键点：
 * - 分片数按 `#EXTINF` 行计数，**不按末段文件名里的序号算**（`...aaa26287.ts` 是第 87 段）。
 * - `durationSec` 是 `#EXTINF` 累加值，核验时与成品 ffprobe 时长比对。
 * - 多码率（master playlist）取 bandwidth 最高的子清单。
 * - 分片/key 的 URI 可能是相对路径；ffmpeg 读的是本地 m3u8 文件，所以必须绝对化。
 */

export interface ManifestVariant {
  url: string;
  bandwidth?: number;
  resolution?: string;
  codecs?: string;
}

export interface ParsedPlaylist {
  /** 是否为多码率主清单（含 `#EXT-X-STREAM-INF`）。 */
  isMaster: boolean;
  variants: ManifestVariant[];
  /** `#EXTINF` 行数。 */
  segments: number;
  /** `#EXTINF` 累加时长（秒）。 */
  durationSec: number;
  hasEndlist: boolean;
  targetDuration?: number;
  segmentUrls: string[];
  /** `#EXT-X-KEY` 里的 URI（解密 key）。 */
  keyUris: string[];
  /** 清单里出现的所有 auth_key 值（用于判断签名过期）。 */
  authKeys: string[];
}

export interface ParsePlaylistOptions {
  /** 用于把相对 URI 转绝对。 */
  baseUrl?: string;
}

const ATTR_RE = (name: string): RegExp => new RegExp(`${name}=(?:"([^"]*)"|([^,]*))`);

function readAttr(attrs: string, name: string): string | undefined {
  const m = ATTR_RE(name).exec(attrs);
  return m?.[1] ?? m?.[2]?.trim();
}

function absolute(uri: string, baseUrl?: string): string {
  const trimmed = uri.trim();
  if (!trimmed) return trimmed;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return trimmed;
  if (!baseUrl) return trimmed;
  try {
    return new URL(trimmed, baseUrl).href;
  } catch {
    return trimmed;
  }
}

/** 解析清单文本（master 或 media playlist 都支持）。 */
export function parsePlaylist(text: string, opts: ParsePlaylistOptions = {}): ParsedPlaylist {
  const lines = String(text ?? '').split(/\r?\n/);
  const variants: ManifestVariant[] = [];
  const segmentUrls: string[] = [];
  const keyUris: string[] = [];
  const authKeys: string[] = [];
  let segments = 0;
  let durationSec = 0;
  let hasEndlist = false;
  let targetDuration: number | undefined;
  let pendingVariant: { bandwidth?: number; resolution?: string; codecs?: string } | null = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line.startsWith('#')) {
      if (line.startsWith('#EXTINF:')) {
        const value = Number.parseFloat(line.slice('#EXTINF:'.length).split(',')[0] ?? '');
        if (Number.isFinite(value) && value >= 0) {
          segments += 1;
          durationSec += value;
        }
      } else if (line.startsWith('#EXT-X-ENDLIST')) {
        hasEndlist = true;
      } else if (line.startsWith('#EXT-X-TARGETDURATION:')) {
        const v = Number.parseFloat(line.slice('#EXT-X-TARGETDURATION:'.length));
        if (Number.isFinite(v)) targetDuration = v;
      } else if (line.startsWith('#EXT-X-STREAM-INF:')) {
        const attrs = line.slice('#EXT-X-STREAM-INF:'.length);
        const bw = Number.parseInt(readAttr(attrs, 'BANDWIDTH') ?? '', 10);
        pendingVariant = {
          bandwidth: Number.isFinite(bw) ? bw : undefined,
          resolution: readAttr(attrs, 'RESOLUTION'),
          codecs: readAttr(attrs, 'CODECS'),
        };
      } else if (line.startsWith('#EXT-X-KEY:')) {
        const attrs = line.slice('#EXT-X-KEY:'.length);
        const uri = readAttr(attrs, 'URI');
        if (uri) keyUris.push(absolute(uri, opts.baseUrl));
      }
      // 其它标签（含 #EXTM3U / #EXT-X-VERSION / #EXT-X-MEDIA-SEQUENCE）忽略
      continue;
    }

    // 非注释行 = URI
    if (pendingVariant) {
      variants.push({ url: absolute(line, opts.baseUrl), ...pendingVariant });
      pendingVariant = null;
      continue;
    }
    segmentUrls.push(absolute(line, opts.baseUrl));
  }

  for (const m of String(text ?? '').matchAll(/auth_key=([0-9]+-[0-9a-f]+-[^&"'\s]+)/gi)) {
    if (m[1]) authKeys.push(m[1]);
  }

  return {
    isMaster: variants.length > 0,
    variants,
    segments,
    durationSec: Number(durationSec.toFixed(6)),
    hasEndlist,
    targetDuration,
    segmentUrls,
    keyUris,
    authKeys,
  };
}

/** 多码率选最高 bandwidth（缺 bandwidth 的排最后）。 */
export function pickVariant(variants: readonly ManifestVariant[]): ManifestVariant | null {
  if (variants.length === 0) return null;
  let best: ManifestVariant | null = null;
  for (const v of variants) {
    if (!best) {
      best = v;
      continue;
    }
    const a = v.bandwidth ?? -1;
    const b = best.bandwidth ?? -1;
    if (a > b) best = v;
  }
  return best;
}

/** 把清单里所有相对 URI 绝对化（segment + `#EXT-X-KEY` 的 URI）。 */
export function absolutizeUris(text: string, baseUrl: string): string {
  return String(text ?? '')
    .split(/\r?\n/)
    .map((raw) => {
      const line = raw.trim();
      if (!line) return raw;
      if (line.startsWith('#')) {
        return raw.replace(/URI="([^"]*)"/g, (whole, uri: string) => {
          const abs = absolute(uri, baseUrl);
          return abs === uri ? whole : `URI="${abs}"`;
        });
      }
      return absolute(line, baseUrl);
    })
    .join('\n');
}

/**
 * 从 `auth_key=<unix>-<hex>-<uid>-<hex>` 里取过期时间（epoch ms）。
 * 无 auth_key 或格式不符返回 undefined（表示「取不到过期时间」，不当作已过期）。
 */
export function parseAuthKeyExpiry(authKey: string | undefined | null): number | undefined {
  if (!authKey) return undefined;
  const decoded = (() => {
    try {
      return decodeURIComponent(authKey);
    } catch {
      return authKey;
    }
  })();
  const m = /^(\d{9,13})-/.exec(decoded.trim());
  if (!m?.[1]) return undefined;
  const n = Number.parseInt(m[1], 10);
  if (!Number.isFinite(n)) return undefined;
  // 10 位数是秒，13 位数是毫秒
  return n < 1e12 ? n * 1000 : n;
}

/** 从 URL 的 query 里取 auth_key。 */
export function authKeyFromUrl(url: string): string | undefined {
  try {
    return new URL(url).searchParams.get('auth_key') ?? undefined;
  } catch {
    return undefined;
  }
}

/** 清单里最早的 auth_key 过期时间（任一 key 过期，整片就下不动了）。 */
export function earliestExpiry(playlist: ParsedPlaylist, url?: string): number | undefined {
  const candidates: number[] = [];
  const fromUrl = parseAuthKeyExpiry(url ? authKeyFromUrl(url) : undefined);
  if (fromUrl) candidates.push(fromUrl);
  for (const key of playlist.authKeys) {
    const exp = parseAuthKeyExpiry(key);
    if (exp) candidates.push(exp);
  }
  return candidates.length > 0 ? Math.min(...candidates) : undefined;
}

/** 过期判断（带 skew，默认提前 30s 视为过期，避免下到一半失效）。 */
export function isExpired(expireAt: number | undefined, now = Date.now(), skewMs = 30_000): boolean {
  if (!expireAt) return false;
  return now + skewMs >= expireAt;
}

/** 必须含 `#EXTM3U`，否则按安全边界停止（不是可公开播放的内容）。 */
export function isHlsManifest(text: string): boolean {
  return /^#EXTM3U/m.test(String(text ?? ''));
}
