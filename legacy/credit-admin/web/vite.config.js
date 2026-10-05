import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

// 后端地址走环境变量，默认 8787。
// 开发时后端常被临时换端口（换后端模式、避开占用），
// 写死 8787 会让 proxy 静默指向一个不存在的服务 ——
// 表现为「前端能开但所有接口都失败」，很难一眼看出原因。
const API = process.env.VITE_API_TARGET || 'http://127.0.0.1:8787';

export default defineConfig({
  plugins: [vue()],
  server: {
    port: Number(process.env.VITE_PORT || 5273),
    host: '127.0.0.1',
    // ★ strictPort 必须开。
    //   默认行为是端口被占用就静默换一个（5273 → 5274），
    //   于是浏览器打开 5273 命中的是上一个旧实例，
    //   它的 proxy 还指着旧后端 —— 表现为「页面能开但接口全 500」，
    //   排查起来极费时间。开成严格模式后端口被占直接报错退出。
    strictPort: true,
    proxy: {
      '/api': { target: API, changeOrigin: true },
    },
  },
  build: {
    chunkSizeWarningLimit: 1500,
  },
});
