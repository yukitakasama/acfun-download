/**
 * 输入归一（PLAN §4.1）。
 *
 * 目标：把「用户给的任意东西」变成一组干净的 URL：
 *   - 纯 URL / 多个 URL
 *   - 分享文本（带中英文文案、表情、全角标点）
 *   - 短链（非目标域名）→ 最多跟 3 次 302
 *   - urls.txt（按行，忽略空行 / `#` / `//`）
 *   - stdin
 * 去重口径：同一 `origin + path` 只保留首次出现（query/hash 不参与去重）。
 */
import { readFile } from 'node:fs/promises';
import { AppError } from '../errors.js';
import { DEFAULT_UA, type FetchLike } from '../net.js';
import { looksLikeTargetUrl, parsePageUrl, pageUrlFromId } from '../site/index.js';
import type { InputItem, PageKind } from '../types.js';

/**
 * 只匹配 URL 安全的 ASCII 字符集（RFC 3986 允许字符）。
 * 这样「中文、表情、全角标点」天然不会被吞进 URL 里。
 */
const URL_RE = /https?:\/\/[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+/g;

/** URL 尾部常见的「不属于 URL」的标点（含中英文）。 */
const TRAILING_JUNK = /[.,!?;:'"`}>，。；！？：、】》」』…]+$/u;

export interface NormalizeOptions {
  /** 注入 fetch，便于单测 mock 短链 302。 */
  fetchImpl?: FetchLike;
  /** 关掉短链跟随（单测/离线用）。 */
  followShortLinks?: boolean;
  /** 纯数字 id 的基准域名（对应 skill 的 --origin 用法）。 */
  origin?: string;
  /** 纯数字 id 默认拼成哪种页面。 */
  idKind?: Extract<PageKind, 'video' | 'post'>;
  /** 单次请求超时。 */
  timeoutMs?: number;
}

export interface ExtractedUrl {
  url: string;
  /** 原始整行（报告中定位用）。 */
  raw: string;
  /** 该行是否为纯 URL（决定 source 是 arg 还是 text）。 */
  wholeLine: boolean;
}

/** 去掉 URL 尾部的中英文标点，并校验可解析性。 */
export function trimUrlTail(url: string): string {
  let out = url;
  for (;;) {
    const next = out.replace(TRAILING_JUNK, '');
    if (next === out) break;
    out = next;
  }
  // 括号/引号不平衡时继续剥（分享文本里常见 "xxx)" ）
  const pairs: ReadonlyArray<[string, string]> = [
    ['(', ')'],
    ['[', ']'],
  ];
  for (const [open, close] of pairs) {
    while (out.endsWith(close) && countOf(out, open) < countOf(out, close)) {
      out = out.slice(0, -1);
    }
  }
  return out;
}

function countOf(s: string, ch: string): number {
  let n = 0;
  for (const c of s) if (c === ch) n++;
  return n;
}

function isAcceptableUrl(candidate: string): boolean {
  try {
    const u = new URL(candidate);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    // 主机名必须有至少一个点（排除 http://foo 之类噪音），localhost 例外。
    return u.hostname === 'localhost' || u.hostname.includes('.');
  } catch {
    return false;
  }
}

/** 从任意文本里抽取 URL（去尾部标点、丢弃不可解析的）。 */
export function extractUrls(text: string): string[] {
  const found: string[] = [];
  for (const m of text.match(URL_RE) ?? []) {
    const cleaned = trimUrlTail(m);
    if (cleaned && isAcceptableUrl(cleaned)) found.push(cleaned);
  }
  return found;
}

/** 文本 → URL 候选（带行列信息）。 */
export function extractFromText(text: string): ExtractedUrl[] {
  const trimmed = text.trim();
  const urls = extractUrls(trimmed);
  const wholeLine = urls.length === 1 && urls[0] === trimmed;
  return urls.map((url) => ({ url, raw: text, wholeLine }));
}

/** 去重键：同一 origin+path 视为同一条（query/hash 忽略）。 */
export function dedupeKey(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
  } catch {
    return url;
  }
}

/**
 * 短链跟随：只在「不像目标页」时才发请求，最多跟 3 跳。
 * 用 `redirect: 'manual'` 只读 location，不真的下载落地页。
 */
export async function followRedirects(
  url: string,
  opts: { maxHops?: number; fetchImpl?: FetchLike; timeoutMs?: number } = {},
): Promise<string> {
  const maxHops = opts.maxHops ?? 3;
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as FetchLike);
  const timeoutMs = opts.timeoutMs ?? 10_000;
  let current = url;
  for (let hop = 0; hop < maxHops; hop++) {
    if (looksLikeTargetUrl(current)) return current;
    let res: Response;
    try {
      res = await fetchImpl(current, {
        method: 'GET',
        redirect: 'manual',
        headers: { 'user-agent': DEFAULT_UA, accept: 'text/html,*/*' },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      // 短链跟随失败不该毁掉主流程：原样返回，后面按 SITE_UNKNOWN 报。
      return current;
    }
    const status = res.status;
    const location = res.headers.get('location');
    if (status < 300 || status >= 400 || !location) return current;
    let next: string;
    try {
      next = new URL(location, current).href;
    } catch {
      return current;
    }
    current = next;
  }
  return current;
}

function isBareId(s: string): boolean {
  return /^\d{3,}$/.test(s);
}

/**
 * 把任意输入集合归一成 InputItem[]（含去重，保留首次出现）。
 *
 * 空行、注释、无法抽取的内容一律跳过——但**不静默丢内容**：
 * 如果最终一条都没有，调用方应报 BAD_INPUT。
 */
export async function normalizeInputs(raws: readonly string[], opts: NormalizeOptions = {}): Promise<InputItem[]> {
  const out: InputItem[] = [];
  const seen = new Set<string>();

  const push = (item: InputItem): void => {
    const key = dedupeKey(item.url);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(item);
  };

  for (const raw of raws) {
    const text = String(raw ?? '');
    const trimmed = text.trim();
    if (!trimmed) continue;

    // 纯数字 id：需要 --origin 才能拼页面地址（对应 skill 的 --origin 用法）。
    if (isBareId(trimmed)) {
      if (!opts.origin) {
        throw new AppError('BAD_INPUT', `输入「${trimmed}」是纯 id，需要同时给 --origin https://<域名>。`);
      }
      const url = pageUrlFromId(opts.origin, trimmed, opts.idKind ?? 'post');
      push({ raw: trimmed, url, source: 'arg' });
      continue;
    }

    const candidates = extractFromText(text);
    for (const cand of candidates) {
      const finalUrl =
        opts.followShortLinks === false ? cand.url : await followRedirects(cand.url, opts);
      push({
        raw: cand.raw,
        url: finalUrl,
        source: cand.wholeLine ? 'arg' : 'text',
      });
    }
  }
  return out;
}

/** 拆行 + 去注释（空行 / `#` / `//`）。 */
export function fileLines(content: string): string[] {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#') && !line.startsWith('//'));
}

/** 从文件读输入：忽略空行、`#` 注释、`//` 注释，行内再做一次分享文本提取，并保留行号。 */
export async function readInputsFromFile(path: string, opts: NormalizeOptions = {}): Promise<InputItem[]> {
  let content: string;
  try {
    content = await readFile(path, 'utf8');
  } catch (e) {
    throw new AppError('IO_ERROR', `读取输入文件失败: ${path}`, { detail: e, cause: e });
  }
  return itemsFromText(content, 'file', opts);
}

/** stdin 与文件同一口径。 */
export async function readInputsFromStdin(opts: NormalizeOptions = {}): Promise<InputItem[]> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Buffer));
  return itemsFromText(Buffer.concat(chunks).toString('utf8'), 'stdin', opts);
}

/** 多行文本 → InputItem[]（去注释、去空行、行内提取、跨行去重、保留行号）。 */
export async function itemsFromText(
  content: string,
  source: InputItem['source'],
  opts: NormalizeOptions = {},
): Promise<InputItem[]> {
  const items: InputItem[] = [];
  const seen = new Set<string>();
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line || line.startsWith('#') || line.startsWith('//')) continue;
    if (isBareId(line)) {
      if (!opts.origin) {
        throw new AppError('BAD_INPUT', `第 ${i + 1} 行是纯 id「${line}」，需要同时给 --origin https://<域名>。`);
      }
      const url = pageUrlFromId(opts.origin, line, opts.idKind ?? 'post');
      const key = dedupeKey(url);
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({ raw: line, url, source, line: i + 1 });
      continue;
    }
    for (const cand of extractFromText(line)) {
      const finalUrl = opts.followShortLinks === false ? cand.url : await followRedirects(cand.url, opts);
      const key = dedupeKey(finalUrl);
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({ raw: cand.raw, url: finalUrl, source, line: i + 1 });
    }
  }
  return items;
}
