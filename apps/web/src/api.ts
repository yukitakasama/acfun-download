/**
 * 与本地服务的通信层：token 管理 + REST + SSE。
 *
 * token 来源优先级：URL 查询参数 `?token=` > localStorage。
 * （Tauri 壳会把 `http://127.0.0.1:<port>/?token=xxx` 注入 WebView。）
 */
const TOKEN_KEY = 'acfun.token';

export interface ApiError {
  kind: string;
  message: string;
  suggestion?: string;
}

export interface Config {
  outDir: string;
  container: 'mp4' | 'mkv' | 'ts';
  nameMode: 'title' | 'custom';
  name?: string;
  template?: string;
  onExist: 'rename' | 'skip' | 'overwrite';
  meta: boolean;
  cover: boolean;
  danmaku: boolean;
  subtitle: boolean;
  concurrency: number;
  retries: number;
  timeoutSec: number;
  intervalMs: number;
  channel: 'auto' | 'ego' | 'chrome';
  ffmpegPath: string;
  ffprobePath: string;
  chromePath?: string;
  proxy?: string;
  cookieFile?: string;
  theme: 'dark' | 'light';
}

export interface TaskView {
  id: string;
  url: string;
  raw: string;
  status: string;
  percent: number;
  timeSec: number;
  attempts: number;
  title?: string;
  outputPath?: string;
  fileSize?: number;
  errorKind?: string;
  message?: string;
  suggestion?: string;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
}

export interface TaskResult {
  taskId: string;
  url: string;
  title?: string;
  status: 'success' | 'failed' | 'skipped';
  filePath?: string;
  fileSize?: number;
  verified?: { frames: number; durationSec: number; manifestDurationSec: number };
  errorKind?: string;
  message?: string;
  suggestion?: string;
  attempts?: number;
  elapsedMs?: number;
}

export interface Stats {
  total: number;
  success: number;
  failed: number;
  skipped: number;
  running: number;
  queued: number;
}

/** 前端展示用的日志行（不是服务端契约）。 */
export interface LogLine {
  ts: number;
  level: 'info' | 'warn' | 'error';
  message: string;
  taskId?: string;
}

export interface ParsePreview {
  ok: boolean;
  url?: string;
  origin?: string;
  kind?: string;
  pageId?: string;
  generation?: string;
  evidence?: string[];
  error?: ApiError;
}

export function initToken(): string {
  const url = new URL(window.location.href);
  const fromQuery = url.searchParams.get('token');
  if (fromQuery) {
    localStorage.setItem(TOKEN_KEY, fromQuery);
    url.searchParams.delete('token');
    window.history.replaceState({}, '', url.toString());
    return fromQuery;
  }
  return localStorage.getItem(TOKEN_KEY) ?? '';
}

export function getToken(): string {
  return localStorage.getItem(TOKEN_KEY) ?? '';
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token.trim());
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken();
  const res = await fetch(path, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(token ? { 'x-acfun-token': token } : {}),
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`服务返回了非 JSON 内容（HTTP ${res.status}）`);
  }
  if (!res.ok) {
    const err = (body as { error?: ApiError })?.error;
    throw new Error(err ? `${err.kind}: ${err.message}` : `HTTP ${res.status}`);
  }
  return body as T;
}

export const api = {
  health: () => request<{ ok: boolean; pid: number; uptimeSec: number; version: string }>('/api/health'),
  config: () => request<{ ok: boolean; config: Config }>('/api/config'),
  saveConfig: (patch: Partial<Config>) =>
    request<{ ok: boolean; config: Config }>('/api/config', { method: 'PUT', body: JSON.stringify(patch) }),
  parse: (input: string) =>
    request<ParsePreview>('/api/parse', { method: 'POST', body: JSON.stringify({ input }) }),
  submit: (payload: { inputs?: string[]; text?: string }) =>
    request<{ ok: boolean; created: TaskView[]; skipped: Array<{ raw: string; reason: string }>; stats: Stats }>(
      '/api/tasks',
      { method: 'POST', body: JSON.stringify(payload) },
    ),
  tasks: () => request<{ ok: boolean; tasks: TaskView[]; stats: Stats }>('/api/tasks'),
  cancel: (id: string) => request<{ ok: boolean }>(`/api/tasks/${id}/cancel`, { method: 'POST' }),
  retry: (id: string) => request<{ ok: boolean; task: TaskView }>(`/api/tasks/${id}/retry`, { method: 'POST' }),
  history: () => request<{ ok: boolean; history: TaskResult[] }>('/api/history'),
  failures: () => request<{ ok: boolean; failures: TaskResult[] }>('/api/failures'),
  shutdown: () => request<{ ok: boolean; message: string }>('/api/shutdown', { method: 'POST' }),
};

export interface SseEvent {
  type: string;
  [key: string]: unknown;
}

/**
 * 连 SSE。断线自动重连（指数退避，最长 15s）。
 * 返回断开函数。
 */
export function connectEvents(
  onEvent: (e: SseEvent) => void,
  onStatus: (connected: boolean, detail?: string) => void,
): () => void {
  let closed = false;
  let es: EventSource | null = null;
  let retry = 1000;

  const open = (): void => {
    if (closed) return;
    const token = encodeURIComponent(getToken());
    es = new EventSource(`/api/events?token=${token}`);

    es.onopen = () => {
      retry = 1000;
      onStatus(true);
    };
    es.onerror = () => {
      es?.close();
      onStatus(false, '连接断开，正在重连…');
      if (closed) return;
      window.setTimeout(open, retry);
      retry = Math.min(retry * 2, 15_000);
    };
    const handler = (type: string) => (ev: MessageEvent) => {
      try {
        const data = JSON.parse(String(ev.data)) as Record<string, unknown>;
        onEvent({ type, ...data });
      } catch {
        /* 忽略无法解析的事件 */
      }
    };
    for (const type of ['hello', 'task', 'progress', 'log', 'done', 'config', 'ping']) {
      es.addEventListener(type, handler(type) as EventListener);
    }
  };

  open();
  return () => {
    closed = true;
    es?.close();
  };
}
