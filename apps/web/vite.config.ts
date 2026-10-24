import { fileURLToPath, URL } from 'node:url';
import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';

/**
 * 前端构建产物给本地服务（apps/server）伺服，也可 `pnpm dev:web` 单独在浏览器里调。
 * dev 时把 /api 代理到本地服务（默认 127.0.0.1:8787，可用 ACFUN_DEV_SERVER 覆盖）。
 */
const devServer = process.env.ACFUN_DEV_SERVER ?? 'http://127.0.0.1:8787';

export default defineConfig({
  base: './',
  plugins: [vue()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: devServer, changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
  },
});
