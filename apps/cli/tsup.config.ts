import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  sourcemap: true,
  clean: true,
  // shebang 直接写在 src/index.ts 首行，tsup 会保留；这里不要再加 banner，否则会重复。
  minify: false,
});
