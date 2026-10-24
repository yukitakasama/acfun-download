export function formatBytes(bytes?: number): string {
  if (!bytes || bytes <= 0) return '-';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(i === 0 ? 0 : 1)}${units[i]}`;
}

export function formatDuration(sec?: number): string {
  if (!sec || sec <= 0) return '-';
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rest = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
  return `${m}:${String(rest).padStart(2, '0')}`;
}

export function formatTime(ts?: number): string {
  if (!ts) return '-';
  const d = new Date(ts);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export const STATUS_LABEL: Record<string, string> = {
  queued: '排队中',
  resolving: '解析中',
  manifest: '取清单',
  downloading: '下载中',
  verifying: '核验中',
  done: '完成',
  failed: '失败',
  skipped: '跳过',
  canceled: '已取消',
};

export const ERROR_LABEL: Record<string, string> = {
  NET_TIMEOUT: '网络超时',
  EDGE_RESET: '边缘节点重置',
  HTTP_403: '403（签名过期/被拦）',
  HTTP_404: '404（内容不存在）',
  AUTH_REQUIRED: '需登录或购买',
  MANIFEST_NOT_HLS: '不可公开播放',
  PAGE_ERROR_TITLE: '页面是错误页',
  PARSE_FAILED: '解析失败',
  SITE_UNKNOWN: '站点无法识别',
  OFFICIAL_UNSUPPORTED: '官方站未适配',
  FFMPEG_MISSING: 'ffmpeg 不可用',
  FFMPEG_FAILED: 'ffmpeg 失败',
  VERIFY_FAILED: '核验未通过',
  USER_ABORT: '用户中断',
  BROWSER_UNAVAILABLE: '浏览器通道不可用',
  IO_ERROR: 'IO 错误',
  BAD_INPUT: '输入有误',
  CANCELED: '已取消',
  UNKNOWN: '未知错误',
};
