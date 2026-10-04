import { fileURLToPath, URL } from 'node:url';

import vue from '@vitejs/plugin-vue';
import AutoImport from 'unplugin-auto-import/vite';
import Components from 'unplugin-vue-components/vite';
import { ElementPlusResolver } from 'unplugin-vue-components/resolvers';
import { defineConfig } from 'vite';

const API_TARGET = 'http://127.0.0.1:8787';

export default defineConfig({
  plugins: [
    vue(),
    AutoImport({
      imports: ['vue', 'vue-router'],
      dts: 'auto-imports.d.ts',
      // Element Plus 的 ElMessage / ElMessageBox / ElNotification 是函数式调用，
      // 不是模板里的组件，必须走 AutoImport 才会带上样式。
      resolvers: [ElementPlusResolver({ importStyle: 'css' })],
    }),
    Components({
      dts: 'components.d.ts',
      resolvers: [ElementPlusResolver({ importStyle: 'css' })],
    }),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5174,
    strictPort: false,
    proxy: {
      // REST 前缀是 /_api（见 docs/API.md）。/api 一并代理，
      // 给未来的图片/静态接口留位置，避免前端出现两套地址。
      '/_api': { target: API_TARGET, changeOrigin: true, ws: true },
      '/api': { target: API_TARGET, changeOrigin: true, ws: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    chunkSizeWarningLimit: 1200,
  },
});
