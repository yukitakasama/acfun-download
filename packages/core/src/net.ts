/**
 * 网络小工具：统一 UA、超时、退避。
 *
 * 不引入 axios/undici —— Node 24 自带 fetch 够用（PLAN §3.3）。
 */

export const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface TextResponse {
  status: number;
  ok: boolean;
  text: string;
  headers: Headers;
  /** 最终 URL（跟随重定向后的）。 */
  url: string;
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 指数退避序列：1s → 2s → 4s（PLAN Q9）。 */
export function backoffDelay(attempt: number): number {
  return 1000 * 2 ** Math.max(0, attempt - 1);
}

export interface HttpOptions {
  timeoutMs?: number;
  headers?: Record<string, string>;
  fetchImpl?: FetchLike;
  method?: string;
  redirect?: RequestRedirect;
  signal?: AbortSignal;
}

/** 取文本（HTML/JSON/清单通用）。失败直接抛，由上层 classifyError 归类。 */
export async function httpText(url: string, opts: HttpOptions = {}): Promise<TextResponse> {
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as FetchLike);
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const signals: AbortSignal[] = [AbortSignal.timeout(timeoutMs)];
  if (opts.signal) signals.push(opts.signal);
  const res = await fetchImpl(url, {
    method: opts.method ?? 'GET',
    redirect: opts.redirect ?? 'follow',
    headers: {
      'user-agent': DEFAULT_UA,
      'accept-language': 'zh-CN,zh;q=0.9',
      ...(opts.headers ?? {}),
    },
    signal: signals.length === 1 ? signals[0] : AbortSignal.any(signals),
  });
  const text = await res.text();
  return { status: res.status, ok: res.ok, text, headers: res.headers, url: res.url || url };
}
