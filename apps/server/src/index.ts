/**
 * 服务入口。
 *
 * 启动后 stdout **首行** 是一条 JSON：`{"type":"server","port":...,"token":...,"url":...}`，
 * 供 Rust 壳/Tauri 读取端口与一次性 token（PLAN §6.6）。其余日志一律走 stderr。
 */
import { randomBytes } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { checkMediaTools, egoStatus } from '@acfun/core';
import { createApp } from './app.js';
import { loadConfig, saveConfig, type AppConfig } from './config.js';
import { TaskManager } from './manager.js';

interface Args {
  port: number;
  host: string;
  token?: string;
  webDir?: string;
  configPath?: string;
  handshake: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { port: 0, host: '127.0.0.1', handshake: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--port':
        args.port = Number.parseInt(argv[++i] ?? '0', 10);
        break;
      case '--host':
        args.host = argv[++i] ?? '127.0.0.1';
        break;
      case '--token':
        args.token = argv[++i];
        break;
      case '--web-dir':
        args.webDir = argv[++i];
        break;
      case '--config':
        args.configPath = argv[++i];
        break;
      case '--no-handshake':
        args.handshake = false;
        break;
      default:
        if (a && !a.startsWith('-')) break;
        break;
    }
  }
  return args;
}

/** 默认前端目录：优先 apps/web/dist（workspace 布局），再退回 server 包旁边的 web/dist。 */
function defaultWebDir(): string | undefined {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, '../../web/dist'),
    resolve(here, '../../../apps/web/dist'),
    resolve(process.cwd(), 'apps/web/dist'),
  ];
  for (const c of candidates) if (existsSync(join(c, 'index.html'))) return c;
  return undefined;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  let config: AppConfig = loadConfig(args.configPath);

  const setConfig = (patch: Partial<AppConfig>): void => {
    config = { ...config, ...patch };
    try {
      saveConfig(config, args.configPath);
    } catch (e) {
      process.stderr.write(`[acfun-server] 保存配置失败: ${(e as Error).message}\n`);
    }
  };

  const manager = new TaskManager(() => config, setConfig);
  const token = args.token ?? process.env.ACFUN_TOKEN ?? randomBytes(16).toString('hex');
  const webDir = args.webDir ?? defaultWebDir();
  const app = createApp({ manager, getConfig: () => config, token, ...(webDir === undefined ? {} : { webDir }) });

  const server = serve({ fetch: app.fetch, hostname: args.host, port: args.port }, (info) => {
    const url = `http://${args.host}:${info.port}/?token=${token}`;
    if (args.handshake) {
      process.stdout.write(`${JSON.stringify({ type: 'server', host: args.host, port: info.port, token, url, pid: process.pid })}\n`);
    }
    process.stderr.write(`[acfun-server] 监听 ${args.host}:${info.port}\n`);
    if (webDir) process.stderr.write(`[acfun-server] 前端目录: ${webDir}\n`);
    else process.stderr.write('[acfun-server] 未找到前端构建产物（pnpm build:web），仅提供 API\n');
    process.stderr.write(`[acfun-server] 打开: ${url}\n`);

    // 环境自检（失败只告警，不影响服务启动）
    void (async () => {
      try {
        const tools = await checkMediaTools(config.ffmpegPath, config.ffprobePath);
        process.stderr.write(`[acfun-server] ${tools.ffmpegVersion}\n`);
      } catch (e) {
        process.stderr.write(`[acfun-server] 警告: ffmpeg/ffprobe 不可用 —— ${(e as Error).message}\n`);
      }
      const ego = await egoStatus();
      process.stderr.write(
        ego.available
          ? `[acfun-server] ego lite: ${ego.version ?? 'unknown'}\n`
          : `[acfun-server] 警告: ego lite 不可用（${ego.error ?? ''}），将回落 Chrome 通道\n`,
      );
    })();
  });

  const shutdown = (signal: string): void => {
    process.stderr.write(`[acfun-server] 收到 ${signal}，停止任务并退出…\n`);
    manager.cancelAll();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

// 作为入口执行
const isMain = ((): boolean => {
  try {
    return process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return true;
  }
})();

if (isMain) {
  main().catch((e: unknown) => {
    process.stderr.write(`[acfun-server] 启动失败: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
    process.exit(1);
  });
}
