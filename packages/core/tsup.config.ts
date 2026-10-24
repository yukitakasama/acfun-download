import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  dts: true,
  sourcemap: true,
  clean: true,
  // 浏览器侧（ego）函数要经 Function.prototype.toString() 序列化后注入 ego 运行时，
  // 因此禁止 minify / 不做 async 降级，并且**必须关掉 keepNames**：
  // keepNames 会往函数体里注入 `__name(...)` 调用，那些 helper 是模块作用域的，
  // 跟着 toString() 进 ego 进程后就变成 `__name is not defined`（实测踩过）。
  minify: false,
  keepNames: false,
  splitting: false,
});
