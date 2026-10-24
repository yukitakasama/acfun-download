/**
 * 命名与输出（PLAN §6.4）。
 *
 * 清洗顺序是硬性约定（顺序错了会出现「开头空格没去掉」「保留名没避开」这类问题）：
 *   模板渲染 → 非法字符/控制字符 → `_` → 连续空白压单空格 → 去首尾空格与结尾 `.`
 *   → 截断到 `200 - ext.length` → 空则回退 `acfun-<id>` → 避开 Windows 保留名
 */
import { extname } from 'node:path';
import type { ContainerFormat, NameMode, OnExist, VideoMeta } from '../types.js';

/** 含扩展名的总长上限（Windows 上下文中 safe 且足够长）。 */
export const MAX_TOTAL_LENGTH = 200;

/** Windows 非法字符（不含扩展名点）与所有控制字符。 */
const ILLEGAL_CHARS = /[\\/:*?"<>|\u0000-\u001f\u007f]/g;

/** Windows 保留设备名（不区分大小写，且带扩展名也算）。 */
const RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** 模板占位符。 */
export const TEMPLATE_PLACEHOLDERS = ['title', 'author', 'date', 'id', 'index'] as const;
export type Placeholder = (typeof TEMPLATE_PLACEHOLDERS)[number];

export interface TemplateVars {
  title?: string;
  author?: string;
  /** 原始发布日期（任意可被 Date 解析的形式）。 */
  date?: string | number | Date;
  id?: string;
  /** 从 1 开始的序号（批量按输入顺序）。 */
  index?: number;
}

export interface SanitizeOptions {
  /** 扩展名（含点，如 `.mp4`）。参与 200 字符预算。 */
  ext?: string;
  /** 总长上限，默认 200。 */
  maxTotalLength?: number;
  /** 清洗后为空时的回退名（通常是 `acfun-<id>`）。 */
  fallback?: string;
}

function codePoints(s: string): string[] {
  return Array.from(s);
}

/** 按「码点」截断，避免把 emoji 的代理对切成半个字符。 */
function truncateByCodePoints(s: string, max: number): string {
  const cps = codePoints(s);
  return cps.length <= max ? s : cps.slice(0, max).join('');
}

/** 避开 Windows 保留设备名：命中则前缀 `_`。 */
export function avoidReservedName(name: string): string {
  const stem = name.split('.')[0] ?? '';
  return RESERVED_NAMES.test(stem) ? `_${name}` : name;
}

/**
 * 文件名清洗。返回**不含扩展名**的基名（扩展名只参与长度预算）。
 */
export function sanitizeFileName(input: string, opts: SanitizeOptions = {}): string {
  const ext = opts.ext ?? '';
  const maxTotal = opts.maxTotalLength ?? MAX_TOTAL_LENGTH;
  const budget = Math.max(1, maxTotal - ext.length);

  let name = String(input ?? '');
  // 1) 非法字符与控制字符 → _
  name = name.replace(ILLEGAL_CHARS, '_');
  // 2) 连续空白（含换行/制表）压成单空格
  name = name.replace(/\s+/g, ' ');
  // 3) 去首尾空格
  name = name.trim();
  // 4) 去结尾的 `.` 与空格（Windows 会静默吞掉，导致实际名字与预期不符）
  name = name.replace(/[. ]+$/g, '');
  // 5) 截断（扩展名预算已扣除）
  name = truncateByCodePoints(name, budget);
  // 截断后可能又留下结尾的点/空格
  name = name.replace(/[. ]+$/g, '');
  // 6) 空（或只剩清洗出来的下划线/空白/点）→ 回退
  if (!name || /^[_\s.]+$/.test(name)) name = opts.fallback ?? 'acfun-unknown';
  // 7) 保留名
  return avoidReservedName(name);
}

/** 序号补零（001 起）。 */
export function padIndex(index: number): string {
  const n = Number.isFinite(index) ? Math.max(1, Math.trunc(index)) : 1;
  return String(n).padStart(3, '0');
}

/**
 * 日期格式化 → `YYYY-MM-DD`。
 * 支持 Date / epoch（秒或毫秒）/ 常见字符串；无法解析返回 ''（这样模板里的括号会被清掉）。
 */
export function formatDate(input?: string | number | Date): string {
  if (input === undefined || input === null || input === '') return '';
  let d: Date;
  if (input instanceof Date) {
    d = input;
  } else if (typeof input === 'number') {
    // 10 位数当秒处理
    d = new Date(input < 1e12 ? input * 1000 : input);
  } else {
    const s = String(input).trim();
    if (!s) return '';
    // 「2026-10-18 12:34:56」这类非 ISO 格式，先规范成 ISO 再解析（避免时区歧义）
    const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(s) ? s.replace(' ', 'T') : s;
    d = new Date(normalized);
  }
  if (Number.isNaN(d.getTime())) return '';
  const y = d.getFullYear();
  if (y < 1970 || y > 3000) return '';
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** 「只含分隔符的括号组」，例如 `[]`、`【 - 】`、`( )`。 */
const EMPTY_GROUP_RE = /[[【(（]\s*[-–—_/\\,:：|·]?\s*[\]】)）]/g;

/** 两端残留的分隔符。 */
const LEADING_SEPARATOR_RE = /^[\s\-–—_/\\,:：|·]+/;
const TRAILING_SEPARATOR_RE = /[\s\-–—_/\\,:：|·]+$/;

/**
 * 模板渲染。
 *
 * - 占位符：`{title}{author}{date}{id}{index}`
 * - 缺字段（空值）时**不留空括号**：`"{title} [{author}]"` + 无 author → `"视频名"`
 * - 未知占位符原样保留：`"{foo}"` → `"{foo}"`
 */
export function renderTemplate(tpl: string, vars: TemplateVars): string {
  const values: Record<Placeholder, string> = {
    title: String(vars.title ?? '').trim(),
    author: String(vars.author ?? '').trim(),
    date: formatDate(vars.date),
    id: String(vars.id ?? '').trim(),
    index: vars.index === undefined ? '' : padIndex(vars.index),
  };

  let out = String(tpl ?? '').replace(/\{(\w+)\}/g, (whole, key: string) => {
    if ((TEMPLATE_PLACEHOLDERS as readonly string[]).includes(key)) {
      return values[key as Placeholder];
    }
    return whole; // 未知占位符保留原文
  });

  // 反复清掉空括号组（可能是嵌套/多个）
  for (let i = 0; i < 8; i++) {
    const next = out.replace(EMPTY_GROUP_RE, ' ');
    if (next === out) break;
    out = next;
  }
  out = out.replace(/\s+/g, ' ').trim();
  out = out.replace(LEADING_SEPARATOR_RE, '').replace(TRAILING_SEPARATOR_RE, '');
  return out.trim();
}

/** 容器格式 → 扩展名（含点）。 */
export function extForContainer(container: ContainerFormat): string {
  return `.${container}`;
}

export interface BuildNameInput {
  mode: NameMode;
  /** custom 固定名。 */
  name?: string;
  /** custom 模板。 */
  template?: string;
  ext: string;
  index: number;
  meta: Pick<VideoMeta, 'videoId' | 'title' | 'author' | 'publishTime'>;
  /** 覆盖回退名用的 id（默认用 meta.videoId）。 */
  fallbackId?: string;
}

/**
 * 生成基名（未清洗）：title 模式用标题；custom 模式用固定名或模板。
 * 清洗交给 sanitizeFileName —— 两者分开才能单测各自边界。
 */
export function buildBaseName(input: BuildNameInput): string {
  const fallback = `acfun-${input.fallbackId ?? input.meta.videoId ?? 'unknown'}`;
  const raw =
    input.mode === 'custom' && input.template
      ? renderTemplate(input.template, {
          title: input.meta.title,
          author: input.meta.author,
          date: input.meta.publishTime,
          id: input.meta.videoId,
          index: input.index,
        })
      : input.mode === 'custom' && input.name
        ? input.name
        : input.meta.title;
  const cleaned = sanitizeFileName(raw, { ext: input.ext, fallback });
  return cleaned;
}

/** 从已有文件名里取扩展名（含点）；取不到返回 ''。 */
export function extensionOf(path: string): string {
  return extname(path);
}

export interface ResolveOutputOptions {
  dir: string;
  baseName: string;
  ext: string;
  onExist: OnExist;
  /** 注入存在性判断，便于单测。 */
  exists: (path: string) => boolean;
  /** 重名后缀上限，防死循环。 */
  maxSuffix?: number;
  /** 拼接路径（默认用 join，注入便于跨平台单测）。 */
  join?: (dir: string, file: string) => string;
}

export interface ResolveOutputResult {
  path: string;
  action: 'write' | 'skip' | 'overwrite';
}

/**
 * 重名处理：rename（默认，`-1`/`-2`…）/ skip / overwrite。
 * `overwrite` 只在显式指定时才覆盖——已完成成品永不隐式覆盖。
 */
export function resolveOutputPath(opts: ResolveOutputOptions): ResolveOutputResult {
  const join = opts.join ?? ((dir: string, file: string) => `${dir.replace(/[\\/]+$/, '')}/${file}`);
  const first = join(opts.dir, `${opts.baseName}${opts.ext}`);
  if (!opts.exists(first)) return { path: first, action: 'write' };
  if (opts.onExist === 'overwrite') return { path: first, action: 'overwrite' };
  if (opts.onExist === 'skip') return { path: first, action: 'skip' };

  const maxSuffix = opts.maxSuffix ?? 9999;
  for (let i = 1; i <= maxSuffix; i++) {
    const candidate = join(opts.dir, `${opts.baseName}-${i}${opts.ext}`);
    if (!opts.exists(candidate)) return { path: candidate, action: 'write' };
  }
  return { path: first, action: 'overwrite' };
}

/** 同名 sidecar 路径：`<base>.meta.json` / `<base>.jpg` / `<base>.danmaku.xml`。 */
export function sidecarPath(dir: string, baseName: string, suffix: string): string {
  return `${dir.replace(/[\\/]+$/, '')}/${baseName}${suffix}`;
}
