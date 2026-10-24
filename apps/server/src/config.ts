/**
 * 配置持久化（PLAN §6.6）。
 *
 * 位置：`%APPDATA%\acfun-download\config.json`（Windows）；其它平台退回 `~/.config/acfun-download/`。
 * 该文件在仓库外，天然不进 git；CLI 也读同一份（`--config` 可覆盖）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import type { ContainerFormat, NameMode, OnExist } from '@acfun/core';

export const AppConfigSchema = z.object({
  outDir: z.string().min(1).default('downloads'),
  container: z.enum(['mp4', 'mkv', 'ts']).default('mp4'),
  nameMode: z.enum(['title', 'custom']).default('title'),
  name: z.string().optional(),
  template: z.string().optional(),
  onExist: z.enum(['rename', 'skip', 'overwrite']).default('rename'),
  meta: z.boolean().default(true),
  cover: z.boolean().default(true),
  danmaku: z.boolean().default(false),
  subtitle: z.boolean().default(false),
  concurrency: z.number().int().min(1).max(8).default(1),
  retries: z.number().int().min(0).max(5).default(2),
  timeoutSec: z.number().int().min(5).max(300).default(30),
  intervalMs: z.number().int().min(0).max(60_000).default(1500),
  channel: z.enum(['auto', 'ego', 'chrome']).default('auto'),
  ffmpegPath: z.string().default('ffmpeg'),
  ffprobePath: z.string().default('ffprobe'),
  chromePath: z.string().optional(),
  proxy: z.string().optional(),
  cookieFile: z.string().optional(),
  theme: z.enum(['dark', 'light']).default('dark'),
});

export type AppConfig = z.infer<typeof AppConfigSchema>;

export const DEFAULT_CONFIG: AppConfig = AppConfigSchema.parse({});

export function configDir(): string {
  if (process.env.ACFUN_CONFIG_DIR) return resolve(process.env.ACFUN_CONFIG_DIR);
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming');
    return join(appData, 'acfun-download');
  }
  return join(homedir(), '.config', 'acfun-download');
}

export function configPath(): string {
  return process.env.ACFUN_CONFIG ? resolve(process.env.ACFUN_CONFIG) : join(configDir(), 'config.json');
}

export function historyPath(): string {
  return join(configDir(), 'history.json');
}

/** 读配置：文件不存在或某项非法时用默认值补齐（不让坏配置把人挡在门外）。 */
export function loadConfig(path: string = configPath()): AppConfig {
  if (!existsSync(path)) return { ...DEFAULT_CONFIG };
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    const parsed = AppConfigSchema.safeParse(raw);
    if (!parsed.success) return { ...DEFAULT_CONFIG };
    return parsed.data;
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function saveConfig(config: AppConfig, path: string = configPath()): void {
  const parsed = AppConfigSchema.parse(config);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
}

/** 配置 → core PipelineOptions 需要的字段（去掉 UI 专属项）。 */
export interface CoreSettings {
  outDir: string;
  container: ContainerFormat;
  nameMode: NameMode;
  name?: string;
  template?: string;
  onExist: OnExist;
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
}

export function toCoreSettings(cfg: AppConfig): CoreSettings {
  return {
    outDir: cfg.outDir,
    container: cfg.container,
    nameMode: cfg.nameMode,
    onExist: cfg.onExist,
    meta: cfg.meta,
    cover: cfg.cover,
    danmaku: cfg.danmaku,
    subtitle: cfg.subtitle,
    concurrency: cfg.concurrency,
    retries: cfg.retries,
    timeoutSec: cfg.timeoutSec,
    intervalMs: cfg.intervalMs,
    channel: cfg.channel,
    ffmpegPath: cfg.ffmpegPath,
    ffprobePath: cfg.ffprobePath,
    ...(cfg.name === undefined ? {} : { name: cfg.name }),
    ...(cfg.template === undefined ? {} : { template: cfg.template }),
    ...(cfg.chromePath === undefined ? {} : { chromePath: cfg.chromePath }),
    ...(cfg.proxy === undefined ? {} : { proxy: cfg.proxy }),
    ...(cfg.cookieFile === undefined ? {} : { cookieFile: cfg.cookieFile }),
  };
}
