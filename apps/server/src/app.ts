/**
 * 本地服务（PLAN §6.6）：Hono REST + SSE，只绑 127.0.0.1，一次性 token 鉴权。
 *
 * 端口用 0（系统分配），启动后把 `{type,port,token,pid}` 作为 **stdout 首行 JSON** 交给壳层。
 * 同时把构建好的前端（apps/web/dist）作为静态资源伺服，便于「浏览器里调试真实 GUI」。
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { checkMediaTools, egoStatus } from '@acfun/core';
import { AppConfigSchema, type AppConfig } from './config.js';
import { previewInput, type TaskManager } from './manager.js';

export interface AppDeps {
  manager: TaskManager;
  getConfig: () => AppConfig;
  token: string;
  /** 前端构建产物目录（不存在则只提供 API）。 */
  webDir?: string;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

function readToken(c: { req: { header: (n: string) => string | undefined; query: (n: string) => string | undefined } }): string | undefined {
  const header = c.req.header('x-acfun-token');
  if (header) return header.trim();
  const auth = c.req.header('authorization');
  if (auth?.startsWith('Bearer ')) return auth.slice(7).trim();
  const q = c.req.query('token');
  return q?.trim();
}

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();

  // ---- 鉴权：除 health 与静态资源，其它都要 token ----
  app.use('/api/*', async (c, next) => {
    if (c.req.path === '/api/health') return next();
    const token = readToken(c);
    if (token !== deps.token) {
      return c.json({ ok: false, error: { kind: 'UNAUTHORIZED', message: '缺少或错误的访问 token' } }, 401);
    }
    return next();
  });

  app.get('/api/health', (c) =>
    c.json({ ok: true, pid: process.pid, uptimeSec: Math.round(process.uptime()), version: '0.6.0' }),
  );

  // ---- 环境探测（设置页的黄色告警就用这个）----
  app.get('/api/env', async (c) => {
    const cfg = deps.getConfig();
    const [tools, ego] = await Promise.all([
      checkMediaTools(cfg.ffmpegPath, cfg.ffprobePath)
        .then((t) => ({ ok: true, version: t.ffmpegVersion }))
        .catch((e: unknown) => ({ ok: false, error: e instanceof Error ? e.message : String(e) })),
      egoStatus().then((s) => ({ ok: s.available, ...(s.version === undefined ? {} : { version: s.version }), ...(s.error === undefined ? {} : { error: s.error }) })),
    ]);
    return c.json({ ok: true, ffmpeg: tools, ego, platform: process.platform, pid: process.pid });
  });

  // ---- 配置 ----
  app.get('/api/config', (c) => c.json({ ok: true, config: deps.getConfig() }));

  app.put('/api/config', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ ok: false, error: { kind: 'BAD_INPUT', message: '请求体必须是 JSON' } }, 400);
    }
    const patch = AppConfigSchema.partial().safeParse(body);
    if (!patch.success) {
      return c.json(
        { ok: false, error: { kind: 'BAD_INPUT', message: patch.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') } },
        400,
      );
    }
    const config = deps.manager.updateConfig(patch.data);
    return c.json({ ok: true, config });
  });

  // ---- 解析预览（不开浏览器，仅判定站点/世代）----
  app.post('/api/parse', async (c) => {
    let body: { input?: string; timeoutSec?: number };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json({ ok: false, error: { kind: 'BAD_INPUT', message: '请求体必须是 JSON' } }, 400);
    }
    if (!body.input || !body.input.trim()) {
      return c.json({ ok: false, error: { kind: 'BAD_INPUT', message: 'input 不能为空' } }, 400);
    }
    const result = await previewInput(body.input, body.timeoutSec ?? deps.getConfig().timeoutSec);
    return c.json(result, result.ok ? 200 : 200);
  });

  // ---- 任务 ----
  app.post('/api/tasks', async (c) => {
    let body: { inputs?: unknown; text?: unknown };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json({ ok: false, error: { kind: 'BAD_INPUT', message: '请求体必须是 JSON' } }, 400);
    }
    const inputs = Array.isArray(body.inputs) ? body.inputs.map((x) => String(x)) : [];
    const text = typeof body.text === 'string' ? body.text : undefined;
    if (inputs.length === 0 && !text) {
      return c.json({ ok: false, error: { kind: 'BAD_INPUT', message: '需要 inputs 或 text' } }, 400);
    }
    try {
      const result = await deps.manager.submit(inputs, text);
      if (result.created.length === 0 && result.skipped.length === 0) {
        return c.json({ ok: false, error: { kind: 'BAD_INPUT', message: '没有从输入里提取到可下载的链接' } }, 400);
      }
      return c.json({ ok: true, ...result, stats: deps.manager.stats() });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return c.json({ ok: false, error: { kind: 'BAD_INPUT', message } }, 400);
    }
  });

  app.get('/api/tasks', (c) => c.json({ ok: true, tasks: deps.manager.list(), stats: deps.manager.stats() }));

  app.post('/api/tasks/:id/cancel', (c) => {
    const id = c.req.param('id');
    const done = deps.manager.cancel(id);
    return c.json({ ok: done, task: deps.manager.get(id) ?? null }, done ? 200 : 404);
  });

  app.post('/api/tasks/:id/retry', (c) => {
    const id = c.req.param('id');
    const created = deps.manager.retry(id);
    return c.json({ ok: Boolean(created), task: created }, created ? 200 : 404);
  });

  app.get('/api/history', (c) => c.json({ ok: true, history: deps.manager.history() }));
  app.get('/api/failures', (c) => c.json({ ok: true, failures: deps.manager.failures() }));

  // ---- SSE ----
  app.get('/api/events', (c) =>
    streamSSE(c, async (stream) => {
      let closed = false;
      let chain: Promise<void> = Promise.resolve();
      const send = (event: string, data: unknown): void => {
        if (closed) return;
        chain = chain
          .then(() => stream.writeSSE({ event, data: JSON.stringify(data) }))
          .catch(() => {
            closed = true;
          });
      };

      send('hello', { ok: true, tasks: deps.manager.list(), stats: deps.manager.stats() });

      const unsub = deps.manager.subscribe((e) => send(e.type, e));
      const heartbeat = setInterval(() => send('ping', { t: Date.now() }), 15_000);

      await new Promise<void>((resolveDone) => {
        const stop = (): void => {
          if (closed) return;
          closed = true;
          clearInterval(heartbeat);
          unsub();
          resolveDone();
        };
        stream.onAbort(stop);
        // 服务端主动关闭时也走同一出口
        stream.onAbort(stop);
      });
    }),
  );

  // ---- 静态资源（前端构建产物）----
  app.get('*', (c) => {
    const webDir = deps.webDir;
    if (!webDir || !existsSync(webDir)) {
      return c.html(
        `<!doctype html><meta charset="utf-8"><title>acfun</title>
         <body style="font-family:system-ui;padding:2rem">
         <h1>AcFun 下载工具 · 本地服务</h1>
         <p>API 已就绪（需要 token）。前端还没构建：先跑 <code>pnpm build:web</code>。</p>
         </body>`,
        200,
      );
    }
    const urlPath = decodeURIComponent(new URL(c.req.url).pathname);
    const safe = normalize(urlPath).replace(/^([/\\])+/, '');
    let file = resolve(webDir, safe || 'index.html');
    if (!file.startsWith(resolve(webDir) + sep) && file !== resolve(webDir, 'index.html')) {
      return c.text('forbidden', 403);
    }
    if (!existsSync(file) || statSync(file).isDirectory()) file = join(webDir, 'index.html');
    if (!existsSync(file)) return c.text('not found', 404);
    const body = readFileSync(file);
    return new Response(body, {
      headers: { 'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream' },
    });
  });

  return app;
}
