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
  // 因此禁止 minify / 不做 async 降级，并用 keepNames 保住函数名。
  minify: false,
  keepNames: true,
  splitting: false,
});
