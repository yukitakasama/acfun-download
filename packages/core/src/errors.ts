/**
 * 错误分类（PLAN §6.2）。
 *
 * 硬性要求：任何失败都必须有 `kind + message + suggestion`，禁止静默失败。
 * `retryable` 决定是否进入重试轮：需鉴权/内容不可播这类错误重试无意义，必须立刻停。
 */

export type ErrorKind =
  | 'NET_TIMEOUT'
  | 'EDGE_RESET'
  | 'HTTP_403'
  | 'HTTP_404'
  | 'AUTH_REQUIRED'
  | 'MANIFEST_NOT_HLS'
  | 'PAGE_ERROR_TITLE'
  | 'PARSE_FAILED'
  | 'SITE_UNKNOWN'
  | 'OFFICIAL_UNSUPPORTED'
  | 'FFMPEG_MISSING'
  | 'FFMPEG_FAILED'
  | 'VERIFY_FAILED'
  | 'USER_ABORT'
  | 'BROWSER_UNAVAILABLE'
  | 'IO_ERROR'
  | 'BAD_INPUT'
  | 'CANCELED'
  | 'UNKNOWN';

/** 每个 kind 的默认建议文案。AppError 未显式给 suggestion 时用它。 */
export const ERROR_SUGGESTIONS: Record<ErrorKind, string> = {
  NET_TIMEOUT: '检查网络与代理设置；马甲域偶发 RST，重跑一次通常即可。',
  EDGE_RESET: '边缘节点随机重置连接（curl 同样会中招），重跑一轮即可；已自动重试两轮。',
  HTTP_403: '分片签名只有几分钟时效；重新取清单再下。若持续 403，内容可能已下架或需登录。',
  HTTP_404: '内容可能已下架，或页面 id/域名不对。',
  AUTH_REQUIRED: '该内容需要登录或购买才能播放，本工具不做绕过。换公开内容，或用带登录态的 ego lite 通道。',
  MANIFEST_NOT_HLS: '返回内容不是 HLS 清单，说明该内容不可公开播放，已按安全边界停止。',
  PAGE_ERROR_TITLE: '页面标题是错误页（站点对无效 id 会回退播放别的内容），已拦截以免交付错误视频。',
  PARSE_FAILED: '解析页面失败；确认链接是播放页/社区帖，并检查是否需要代理。',
  SITE_UNKNOWN: '无法判定站点世代。确认域名是马甲域（*.work 等）、页面能正常打开、未被 WAF 拦截；必要时加 --proxy。',
  OFFICIAL_UNSUPPORTED:
    '官方站 www.acfun.cn 需另做逆向适配，本次未实现（已知限制，README 标注为实验性）。可改用马甲域链接。',
  FFMPEG_MISSING: '安装 ffmpeg/ffprobe 并加入 PATH，或在设置里填写可执行文件路径。',
  FFMPEG_FAILED: 'ffmpeg 转封装失败，多为分片签名过期；已整片重取清单重试。',
  VERIFY_FAILED: '全量解码核验未通过（疑似丢分片），不能交付；已重试两轮，仍失败则删除残件。',
  USER_ABORT: '已按 Ctrl+C 中断，保留 .part 与清单；用 --resume 继续。',
  BROWSER_UNAVAILABLE: '确认 ego lite 已安装并在运行（ego-browser --version 有输出）；否则改用 Chrome 兜底通道（需装 Chrome）。',
  IO_ERROR: '检查输出目录是否可写、磁盘是否已满。',
  BAD_INPUT: '检查参数拼写；acfun --help 查看完整用法。',
  CANCELED: '任务已被取消。',
  UNKNOWN: '未分类错误，请加 --verbose 复现并附日志。',
};

/** 可重试的错误（进入「两轮整片重试」或退避重试）。 */
const RETRYABLE: ReadonlySet<ErrorKind> = new Set<ErrorKind>([
  'NET_TIMEOUT',
  'EDGE_RESET',
  'HTTP_403',
  'HTTP_404',
  'FFMPEG_FAILED',
  'VERIFY_FAILED',
  'UNKNOWN',
]);

export class AppError extends Error {
  readonly kind: ErrorKind;
  readonly suggestion: string;
  readonly retryable: boolean;
  /** 原始错误/响应片段，只用于日志，不进面向用户的文案。 */
  readonly detail?: unknown;

  constructor(kind: ErrorKind, message: string, opts: { suggestion?: string; detail?: unknown; cause?: unknown } = {}) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = 'AppError';
    this.kind = kind;
    this.suggestion = opts.suggestion ?? ERROR_SUGGESTIONS[kind];
    this.retryable = RETRYABLE.has(kind);
    this.detail = opts.detail;
  }

  toJSON(): { kind: ErrorKind; message: string; suggestion: string; retryable: boolean } {
    return {
      kind: this.kind,
      message: this.message,
      suggestion: this.suggestion,
      retryable: this.retryable,
    };
  }
}

export function isRetryable(kind: ErrorKind): boolean {
  return RETRYABLE.has(kind);
}

const MSG_RULES: ReadonlyArray<{ re: RegExp; kind: ErrorKind }> = [
  { re: /ERR_CONNECTION_RESET|ECONNRESET|socket hang up|EPIPE/i, kind: 'EDGE_RESET' },
  { re: /timeout|ETIMEDOUT|aborted|AbortError/i, kind: 'NET_TIMEOUT' },
  { re: /\b403\b|Request blocked/i, kind: 'HTTP_403' },
  { re: /\b404\b/i, kind: 'HTTP_404' },
  { re: /ENOENT|not found.*ffmpeg|ffmpeg: not found/i, kind: 'FFMPEG_MISSING' },
  { re: /未捕获 authPath|authPath/i, kind: 'AUTH_REQUIRED' },
  { re: /canWatch|previewUrl|需要登录|购买/i, kind: 'AUTH_REQUIRED' },
  { re: /不是 HLS 清单|不是HLS清单|EXTM3U/i, kind: 'MANIFEST_NOT_HLS' },
  { re: /\bEACCES\b|ENOSPC|EPERM/i, kind: 'IO_ERROR' },
  { re: /ego-browser|ego lite/i, kind: 'BROWSER_UNAVAILABLE' },
];

/**
 * 把任意抛出物归一成 AppError。
 * 已分类的错误原样返回，避免重复包装导致 kind 漂移。
 */
export function classifyError(e: unknown, fallback: ErrorKind = 'UNKNOWN'): AppError {
  if (e instanceof AppError) return e;
  const message = e instanceof Error ? e.message : typeof e === 'string' ? e : JSON.stringify(e);
  for (const r of MSG_RULES) {
    if (r.re.test(message)) return new AppError(r.kind, message, { cause: e });
  }
  return new AppError(fallback, message, { cause: e });
}
