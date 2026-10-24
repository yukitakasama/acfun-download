/**
 * Chrome + CDP 兜底通道（ego lite 不可用时才走这里，PLAN §4.3）。
 *
 * 用最小 CDP 客户端（Node 24 自带 WebSocket），不引 puppeteer。
 * 关键做法（照 skill 踩坑）：
 *   - 用 PowerShell `Start-Process` **分离启动**：Bash 里 `chrome.exe ... &` 起的进程有概率
 *     随调用结束被进程树清理，接着连 CDP 就 ECONNREFUSED（几秒前 curl 还通，极易误判成站点问题）。
 *   - 每次用**独立 --user-data-dir + 空闲端口**，避免串到上一个会话的标签。
 *   - `Network.enable` 早于导航；事件先攒进数组，`events()` 取走并清空（与 ego 语义一致）。
 */
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppError } from '../errors.js';
import type { BrowserEvent, BrowserFetchResult, BrowserPage, CaptureItem, CaptureRecord } from './capture.js';
import { captureRound } from './capture.js';
import { runProcess } from './spawn.js';
import { sleep } from '../net.js';

/** 常见安装路径；也支持 CHROME_PATH 环境变量与显式传入。 */
export function chromeCandidates(): string[] {
  const list = [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe') : undefined,
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  ];
  return list.filter((x): x is string => Boolean(x));
}

export function findChromePath(explicit?: string): string | null {
  if (explicit) return existsSync(explicit) ? explicit : null;
  for (const p of chromeCandidates()) if (existsSync(p)) return p;
  return null;
}

/** 找一个空闲端口（避免撞上上次会话残留的 9223）。 */
export async function findFreePort(preferred = 0): Promise<number> {
  const tryBind = (port: number): Promise<number | null> =>
    new Promise((resolve) => {
      const srv = createServer();
      srv.once('error', () => resolve(null));
      srv.once('listening', () => {
        const addr = srv.address();
        const p = typeof addr === 'object' && addr ? addr.port : port;
        srv.close(() => resolve(p));
      });
      srv.listen(port, '127.0.0.1');
    });
  if (preferred > 0) {
    const got = await tryBind(preferred);
    if (got) return got;
  }
  const got = await tryBind(0);
  if (!got) throw new AppError('BROWSER_UNAVAILABLE', '找不到可用的本地端口用于启动 Chrome');
  return got;
}

interface CdpMessage {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { message?: string };
}

/** 极简 CDP 客户端：send / on / close。 */
export class CdpClient {
  private seq = 0;
  private readonly pending = new Map<number, { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void }>();
  private readonly listeners = new Map<string, Set<(params: Record<string, unknown>) => void>>();

  private constructor(private readonly ws: WebSocket) {
    ws.addEventListener('message', (ev: MessageEvent) => this.onMessage(String(ev.data)));
  }

  static async connect(wsUrl: string, timeoutMs = 20_000): Promise<CdpClient> {
    const ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new AppError('BROWSER_UNAVAILABLE', 'CDP WebSocket 连接超时')), timeoutMs);
      ws.addEventListener('open', () => {
        clearTimeout(timer);
        resolve();
      });
      ws.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new AppError('BROWSER_UNAVAILABLE', `CDP WebSocket 连接失败: ${wsUrl}`));
      });
    });
    return new CdpClient(ws);
  }

  private onMessage(raw: string): void {
    let msg: CdpMessage;
    try {
      msg = JSON.parse(raw) as CdpMessage;
    } catch {
      return;
    }
    if (typeof msg.id === 'number') {
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      this.pending.delete(msg.id);
      if (msg.error) entry.reject(new Error(msg.error.message ?? 'CDP error'));
      else entry.resolve(msg.result ?? {});
      return;
    }
    if (msg.method) {
      const set = this.listeners.get(msg.method);
      if (!set) return;
      for (const cb of set) {
        try {
          cb(msg.params ?? {});
        } catch {
          /* 监听器异常不能污染 CDP 循环 */
        }
      }
    }
  }

  send(method: string, params: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<Record<string, unknown>> {
    const id = ++this.seq;
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`CDP 超时: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e as Error);
      }
    });
  }

  on(method: string, cb: (params: Record<string, unknown>) => void): () => void {
    let set = this.listeners.get(method);
    if (!set) {
      set = new Set();
      this.listeners.set(method, set);
    }
    set.add(cb);
    return () => set?.delete(cb);
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

/** 把 CDP 页面包装成 captureRound 认识的 driver。 */
export class CdpPageDriver implements BrowserPage {
  private buffered: BrowserEvent[] = [];

  constructor(private readonly client: CdpClient) {
    client.on('Network.requestWillBeSent', (params) => {
      this.buffered.push({ method: 'Network.requestWillBeSent', params: params as BrowserEvent['params'] });
    });
  }

  async cdp(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    return this.client.send(method, params);
  }

  async goto(url: string): Promise<unknown> {
    await this.client.send('Page.enable');
    await this.client.send('Page.navigate', { url });
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      try {
        const state = await this.evaluateRaw('document.readyState');
        if (state === 'complete') break;
      } catch {
        /* 导航中求值失败属正常 */
      }
      await sleep(300);
    }
    await sleep(500); // 给 SPA 起播一点时间
    return undefined;
  }

  async events(): Promise<BrowserEvent[]> {
    const out = this.buffered;
    this.buffered = [];
    return out;
  }

  async fetch(
    url: string,
    opts?: { timeout?: number; headers?: Record<string, string>; method?: string; body?: string },
  ): Promise<BrowserFetchResult> {
    const payload = JSON.stringify({
      url,
      headers: opts?.headers ?? {},
      method: opts?.method ?? 'GET',
      body: opts?.body ?? null,
    });
    const expr = `(async () => {
      const p = ${payload};
      const init = { method: p.method, headers: p.headers, credentials: 'include' };
      if (p.body) init.body = p.body;
      const r = await fetch(p.url, init);
      return JSON.stringify({ ok: r.ok, status: r.status, body: await r.text() });
    })()`;
    const raw = await this.evaluateRaw(expr, true, opts?.timeout ?? 30_000);
    if (typeof raw !== 'string') return { ok: false, status: 0, body: '' };
    try {
      const parsed = JSON.parse(raw) as BrowserFetchResult;
      return { ok: Boolean(parsed.ok), status: Number(parsed.status) || 0, body: String(parsed.body ?? '') };
    } catch {
      return { ok: false, status: 0, body: '' };
    }
  }

  async evaluate(expression: string): Promise<unknown> {
    return this.evaluateRaw(expression);
  }

  private async evaluateRaw(expression: string, awaitPromise = false, timeoutMs = 30_000): Promise<unknown> {
    const res = (await this.client.send(
      'Runtime.evaluate',
      { expression, awaitPromise, returnByValue: true },
      timeoutMs,
    )) as { result?: { value?: unknown }; exceptionDetails?: { text?: string } };
    if (res.exceptionDetails) throw new Error(res.exceptionDetails.text ?? '页面内脚本执行失败');
    return res.result?.value;
  }
}

export interface ChromeSession {
  driver: CdpPageDriver;
  port: number;
  pid: number | null;
  close: () => Promise<void>;
}

export interface LaunchChromeOptions {
  chromePath?: string;
  proxy?: string;
  cookieFile?: string;
  timeoutMs?: number;
}

/** 分离启动隔离的 headless Chrome 并连上它的页面 target。 */
export async function launchChrome(opts: LaunchChromeOptions = {}): Promise<ChromeSession> {
  const exe = findChromePath(opts.chromePath);
  if (!exe) {
    throw new AppError('BROWSER_UNAVAILABLE', '找不到 Chrome/Edge 可执行文件（Chrome 兜底通道不可用）', {
      suggestion: '安装 Chrome，或用 --chrome <路径> 指定；有 ego lite 时优先用 ego 通道。',
    });
  }
  const port = await findFreePort();
  const userDataDir = mkdtempSync(join(tmpdir(), 'acfun-cdp-'));
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--mute-audio',
    // 社区帖靠自动起播才会发出 authPath 请求，headless 默认会挡自动播放
    '--autoplay-policy=no-user-gesture-required',
    // 取清单要在页面上下文 fetch 跨域 API（acpcssr.*.work）；这是隔离的临时 profile，
    // 关掉同源限制只为让 fetch 不被 CORS 拦，不影响用户自己的浏览器。
    '--disable-web-security',
    '--disable-site-isolation-trials',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-features=Translate,BackForwardCache,IsolateOrigins,site-per-process',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
  ];
  if (opts.proxy) args.push(`--proxy-server=${opts.proxy}`);
  args.push('about:blank');

  const quote = (s: string): string => `'${s.replace(/'/g, "''")}'`;
  const psCommand = `$p = Start-Process -FilePath ${quote(exe)} -ArgumentList ${args
    .map(quote)
    .join(',')} -PassThru; Write-Output $p.Id`;
  const launched = await runProcess('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psCommand], {
    timeoutMs: 25_000,
  });
  const pid = Number.parseInt(launched.stdout.trim(), 10) || null;

  const deadline = Date.now() + (opts.timeoutMs ?? 25_000);
  let wsUrl: string | null = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (res.ok) {
        const list = (await res.json()) as Array<{ type?: string; webSocketDebuggerUrl?: string }>;
        const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
        if (page?.webSocketDebuggerUrl) {
          wsUrl = page.webSocketDebuggerUrl;
          break;
        }
      }
    } catch {
      /* 还没起好 */
    }
    await sleep(400);
  }
  if (!wsUrl) {
    if (pid) await runProcess('taskkill', ['/PID', String(pid), '/T', '/F'], { timeoutMs: 8000 });
    throw new AppError('BROWSER_UNAVAILABLE', `Chrome 已启动但 CDP 端口 ${port} 不可用（可能被杀或端口被占）`);
  }

  const client = await CdpClient.connect(wsUrl);
  const driver = new CdpPageDriver(client);
  if (opts.cookieFile) {
    const cookies = loadCookies(opts.cookieFile);
    if (cookies.length > 0) {
      try {
        await client.send('Network.enable');
        await client.send('Network.setCookies', { cookies });
      } catch {
        /* cookie 注入失败不阻塞（公开内容不需要） */
      }
    }
  }

  return {
    driver,
    port,
    pid,
    close: async () => {
      client.close();
      if (pid) await runProcess('taskkill', ['/PID', String(pid), '/T', '/F'], { timeoutMs: 8000 });
    },
  };
}

interface CookieInput {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  secure?: boolean;
}

/**
 * 读 cookie 文件：支持 Netscape cookies.txt，也支持每行 `name=value`。
 * 只给 Chrome 兜底通道用（ego 通道走用户真实 profile，天然带登录态）。
 */
export function loadCookies(file: string): CookieInput[] {
  if (!existsSync(file)) return [];
  const content = readFileSync(file, 'utf8');
  const out: CookieInput[] = [];
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const cols = line.split('\t');
    if (cols.length >= 7) {
      const [domain, , , secure, , name, value] = cols;
      if (domain && name) {
        out.push({ name, value: value ?? '', domain, path: '/', secure: secure?.toUpperCase() === 'TRUE' });
      }
      continue;
    }
    const eq = line.indexOf('=');
    if (eq > 0) out.push({ name: line.slice(0, eq).trim(), value: line.slice(eq + 1).trim() });
  }
  return out;
}

export interface ChromeCaptureOptions extends LaunchChromeOptions {
  generation: 'nuxt' | 'vite';
  items: CaptureItem[];
  resultFile: string;
  captureTimeoutMs?: number;
  fetchTimeoutMs?: number;
}

/** 用 Chrome 兜底通道跑一轮取清单（与 ego 通道共用同一份 captureRound 逻辑）。 */
export async function runChromeCapture(opts: ChromeCaptureOptions): Promise<CaptureRecord[]> {
  const session = await launchChrome(opts);
  try {
    await captureRound({
      generation: opts.generation,
      items: opts.items,
      resultFile: opts.resultFile,
      page: session.driver,
      ...(opts.captureTimeoutMs === undefined ? {} : { captureTimeoutMs: opts.captureTimeoutMs }),
      ...(opts.fetchTimeoutMs === undefined ? {} : { fetchTimeoutMs: opts.fetchTimeoutMs }),
    });
    const content = readFileSync(opts.resultFile, 'utf8');
    return JSON.parse(content) as CaptureRecord[];
  } finally {
    await session.close();
  }
}
