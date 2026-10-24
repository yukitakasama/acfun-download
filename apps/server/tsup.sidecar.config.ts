import { defineConfig } from 'tsup';

/**
 * 桌面壳用的 server bundle：**把所有依赖打进来**（noExternal），
 * 这样 sidecar 只需要 node.exe + 这一个 index.js，不用带 node_modules。
 */
export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'dist-sidecar',
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  bundle: true,
  splitting: false,
  sourcemap: false,
  clean: true,
  minify: false,
  noExternal: [/.*/],
  outExtension: () => ({ js: '.js' }),
});
