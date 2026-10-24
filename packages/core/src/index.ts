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
export * from './manifest/index.js';
export * from './browser/capture.js';
export * from './browser/ego.js';
export * from './browser/chrome.js';
export * from './browser/spawn.js';
export * from './site/official.js';
export * from './resolve.js';
export * from './download/index.js';
export * from './pipeline.js';
export * from './concurrency.js';
export * from './report/index.js';
export const CORE_VERSION = '0.4.0';
