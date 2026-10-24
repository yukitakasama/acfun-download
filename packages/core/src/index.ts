/**
 * @acfun/core —— 全部业务逻辑，无 UI；除显式调用的 ffmpeg/ego 子进程外无副作用。
 *
 * 分层：input → site → manifest → download → verify → naming → report
 */
export * from './types.js';
export * from './errors.js';
export * from './net.js';
export * from './input/index.js';
export * from './site/index.js';
export * from './naming/index.js';
export const CORE_VERSION = '0.2.0';
