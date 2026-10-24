/**
 * @acfun/core —— 全部业务逻辑，无 UI、无进程副作用（除显式调用的 ffmpeg/ego 子进程）。
 *
 * 分层：input → site → manifest → download → verify → naming → report
 * 本文件只做聚合导出，逻辑散在各自的子目录里。
 */
export const CORE_VERSION = '0.0.0';
