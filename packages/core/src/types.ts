/**
 * 核心数据结构（对应 PLAN §6.1）。
 *
 * 这些类型是 core / CLI / server / GUI 之间唯一的契约，改动需同步 README 与 GUI 类型。
 */
import type { AppError } from './errors.js';

/** 站点前端世代。`official` 指 www.acfun.cn 官方站（仅尽力解析）。 */
export type Generation = 'vite' | 'nuxt' | 'official' | 'unknown';

/** 页面种类。`post` = 社区动态（帖内嵌视频，帖子 id ≠ 视频 id）。 */
export type PageKind = 'video' | 'post' | 'article';

/** 输入来源，用于报告定位与 `{index}` 序号。 */
export type InputSource = 'arg' | 'text' | 'file' | 'stdin';

export type TaskStatus =
  | 'queued'
  | 'resolving'
  | 'manifest'
  | 'downloading'
  | 'verifying'
  | 'done'
  | 'failed'
  | 'skipped'
  | 'canceled';

/** 一条归一化后的输入。`raw` 保留原始行，便于报告定位到用户给的那一行。 */
export interface InputItem {
  raw: string;
  url: string;
  line?: number;
  source: InputSource;
}

/** 站点判定结果（不需要开浏览器，裸 HTML 特征即可）。 */
export interface ParsedTarget {
  url: string;
  origin: string;
  host: string;
  path: string;
  kind: PageKind;
  /** 页面 id：/play/<id>、/community/<id>、/v/ac<id> 里的数字部分。 */
  pageId: string;
  generation: Generation;
}

/** 判定世代时命中的特征串，便于报告与排障。 */
export interface GenerationEvidence {
  generation: Generation;
  evidence: string[];
}

export interface VideoMeta {
  videoId: string;
  title: string;
  author: string;
  authorId?: string;
  publishTime?: string;
  durationSec?: number;
  coverUrl?: string;
  pageUrl: string;
  generation: Generation;
}

/** 清单解析结果。durationSec 是 `#EXTINF` 累加值，核验时与成品时长比对。 */
export interface Manifest {
  playlistUrl: string;
  text: string;
  /** 分片条数（按 `#EXTINF` 计，不按末段序号算）。 */
  segments: number;
  durationSec: number;
  /** 多码率时选中的码率（bps）。 */
  variantBandwidth?: number;
  hasEndlist: boolean;
  /** auth_key 过期时间（epoch ms），取不到则不填。 */
  keyExpireAt?: number;
  /** 命中的子清单地址（多码率时）。 */
  variantUrl?: string;
}

export interface TaskProgress {
  percent: number;
  timeSec: number;
  bytes?: number;
  segDone?: number;
  segTotal: number;
}

export interface Task {
  id: string;
  item: InputItem;
  status: TaskStatus;
  attempts: number;
  progress: TaskProgress;
  meta?: VideoMeta;
  outputPath?: string;
  error?: AppError;
  startedAt?: number;
  finishedAt?: number;
}

export type TaskResultStatus = 'success' | 'failed' | 'skipped';

/** 一条任务的最终结果（写进报告/失败清单）。 */
export interface TaskResult {
  taskId: string;
  url: string;
  title?: string;
  status: TaskResultStatus;
  filePath?: string;
  fileSize?: number;
  verified?: { frames: number; durationSec: number; manifestDurationSec: number };
  errorKind?: string;
  message?: string;
  suggestion?: string;
  attempts?: number;
  elapsedMs?: number;
}

/** 下载容器格式；统一 `-c copy` 转封装，不重编码。 */
export type ContainerFormat = 'mp4' | 'mkv' | 'ts';

/** 重名处理策略。 */
export type OnExist = 'rename' | 'skip' | 'overwrite';

/** 命名模式：默认用标题，或自定义固定名/模板。 */
export type NameMode = 'title' | 'custom';
