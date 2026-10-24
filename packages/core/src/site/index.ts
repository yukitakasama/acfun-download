/**
 * 站点与世代判定（PLAN §4.2）。
 *
 * 关键点：**不用先开浏览器**。马甲域的 HTML 本身可以裸 curl 到（被拦的只是带签名的 API），
 * 所以用一次普通 GET + 特征 grep 就能分流两代前端：
 *
 *   /_nuxt/            → Nuxt 3 世代（免鉴权 public authPath，无 aut、无加密）
 *   acpcssr.<rand>.work → Nuxt 3 世代（跨域 API 主机）
 *   /assets/index-      → Vite 世代（aut JWT + t/s 签名 + AES-CBC 加密响应 + canWatch）
 */
import { AppError } from '../errors.js';
import { httpText, type FetchLike } from '../net.js';
import type { Generation, GenerationEvidence, PageKind, ParsedTarget } from '../types.js';

/** Nuxt 3 世代特征。 */
const NUXT_MARKERS: ReadonlyArray<{ re: RegExp; label: string }> = [
  { re: /\/_nuxt\//, label: '/_nuxt/' },
  { re: /https:\/\/acpcssr\.[a-z0-9]+\.work/, label: 'acpcssr.*.work' },
];

/** Vite 世代特征。 */
const VITE_MARKERS: ReadonlyArray<{ re: RegExp; label: string }> = [
  { re: /\/assets\/index-/, label: '/assets/index-' },
  { re: /\/_app\.config\.js/, label: '/_app.config.js' },
];

interface PathRule {
  re: RegExp;
  kind: PageKind;
  generation?: Generation;
  /** 从捕获组取 id，缺省用第 1 组。 */
  idGroup?: number;
}

/** 路径规则表。顺序有意义：`/videos/play/` 必须早于 `/play/`。 */
const PATH_RULES: readonly PathRule[] = [
  { re: /^\/videos\/play\/(\d+)\/?$/, kind: 'video' },
  { re: /^\/play\/(\d+)\/?$/, kind: 'video' },
  { re: /^\/splay\/(\d+)\/?$/, kind: 'video' },
  { re: /^\/community\/(\d+)\/?$/, kind: 'post' },
  { re: /^\/v\/ac(\d+)\/?$/, kind: 'video', generation: 'official' },
  { re: /^\/t\/ac(\d+)\/?$/, kind: 'article', generation: 'official' },
];

/**
 * 解析页面 URL。无法识别返回 null（由调用方报 SITE_UNKNOWN / BAD_INPUT）。
 * 注意 `/community/<id>` 是社区动态，帖子 id ≠ 视频 id（视频 id 只能从页面实发请求里抓）。
 */
export function parsePageUrl(input: string): ParsedTarget | null {
  const trimmed = String(input ?? '').trim();
  if (!trimmed) return null;
  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;

  const path = u.pathname.replace(/\/{2,}/g, '/');
  for (const rule of PATH_RULES) {
    const m = rule.re.exec(path);
    if (!m) continue;
    const id = m[rule.idGroup ?? 1] ?? '';
    if (!id) continue;
    return {
      url: u.href,
      origin: u.origin,
      host: u.host,
      path,
      kind: rule.kind,
      pageId: id,
      generation: rule.generation ?? 'unknown',
    };
  }
  return null;
}

/** 是否是我们认识的页面形态（短链跟随据此决定要不要发请求）。 */
export function looksLikeTargetUrl(input: string): boolean {
  return parsePageUrl(input) !== null;
}

/** 用 id + origin 拼页面地址。`post` 拼 /community/，`video` 拼 /play/。 */
export function pageUrlFromId(origin: string, id: string, kind: Extract<PageKind, 'video' | 'post'> = 'post'): string {
  const base = origin.replace(/\/+$/, '');
  if (!/^\d+$/.test(id)) {
    throw new AppError('BAD_INPUT', `页面 id 必须是纯数字，收到「${id}」。`);
  }
  return `${base}/${kind === 'video' ? 'play' : 'community'}/${id}`;
}

/** 从 HTML 判定世代，同时回传命中的特征串（报告里能说清「凭什么这么判」）。 */
export function detectGenerationFromHtml(html: string): GenerationEvidence {
  const text = String(html ?? '');
  const evidence: string[] = [];
  for (const m of NUXT_MARKERS) if (m.re.test(text)) evidence.push(m.label);
  if (evidence.length > 0) return { generation: 'nuxt', evidence };
  for (const m of VITE_MARKERS) if (m.re.test(text)) evidence.push(m.label);
  if (evidence.length > 0) return { generation: 'vite', evidence };
  return { generation: 'unknown', evidence: [] };
}

export interface DetectOptions {
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  /** 已经知道世代时跳过网络。 */
  skipFetch?: boolean;
}

export interface SiteDetection {
  target: ParsedTarget;
  evidence: string[];
}

/**
 * 判站点世代：官方站直接标记 `official`（走尽力解析，不查 HTML）。
 * 其余抓一次 HTML 做特征匹配；抓不到/特征全无 → SITE_UNKNOWN（带建议）。
 */
export async function detectSite(input: string, opts: DetectOptions = {}): Promise<SiteDetection> {
  const target = parsePageUrl(input);
  if (!target) {
    throw new AppError('SITE_UNKNOWN', `无法识别的链接形态: ${input}`);
  }
  if (target.generation === 'official') {
    return { target, evidence: ['www.acfun.cn 官方站'] };
  }
  if (opts.skipFetch) return { target, evidence: [] };

  let res;
  try {
    res = await httpText(target.url, {
      timeoutMs: opts.timeoutMs ?? 30_000,
      fetchImpl: opts.fetchImpl,
      headers: { accept: 'text/html,application/xhtml+xml,*/*' },
    });
  } catch (e) {
    throw new AppError('PARSE_FAILED', `抓取页面失败: ${target.url}`, {
      suggestion: '检查网络/代理；马甲域偶发 RST，重跑一次通常即可。',
      detail: e,
      cause: e,
    });
  }
  if (!res.ok) {
    const kind = res.status === 404 ? 'HTTP_404' : res.status === 403 ? 'HTTP_403' : 'PARSE_FAILED';
    throw new AppError(kind, `页面返回 HTTP ${res.status}: ${target.url}`, {
      suggestion:
        res.status >= 500
          ? '站点返回 5xx：多为无效 id（该内容不存在）或边缘节点抖动。确认 id 有效后重试一轮。'
          : undefined,
      detail: res.text.slice(0, 300),
    });
  }

  const detected = detectGenerationFromHtml(res.text);
  if (detected.generation === 'unknown') {
    throw new AppError('SITE_UNKNOWN', `页面里找不到任何世代特征（/_nuxt/、acpcssr.*.work、/assets/index-）: ${target.url}`, {
      detail: { status: res.status, length: res.text.length, snippet: res.text.slice(0, 200) },
    });
  }
  return { target: { ...target, generation: detected.generation }, evidence: detected.evidence };
}

/** 页面标题里的错误页特征（站点对无效 id 会回退播别的内容，交付前要拦）。 */
const ERROR_TITLE_RE =
  /bad\s*gateway|not\s*found|internal\s*server\s*error|service\s*unavailable|^\s*\d{3}\s*$|错误|出错|异常|找不到|不存在|无法访问/i;

export function looksLikeErrorTitle(title: string): boolean {
  return ERROR_TITLE_RE.test(String(title ?? ''));
}

/** 去掉站点标题里的后缀，拿到真正的标题。 */
export function cleanPageTitle(raw: string): string {
  const t = String(raw ?? '')
    .replace(/\s*[-–—|]\s*(社区动态|在线观看|AcFan|Ac_fun|AcFun|ACFUN)\s*$/i, '')
    .replace(/\s*[-–—|]\s*(社区动态|在线观看)\s*/gi, ' ')
    .trim();
  // SPA 还没把标题写上来时，document.title 就是站点名本身，这种「标题」没有信息量。
  if (/^(ac[ _-]?fan|acfun)$/i.test(t)) return '';
  return t;
}
