import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  base: '/', // Cloudflare Pages 域名根路径部署
  plugins: [vue()],
  server: {
    // WS 走同域 /ws：dev 转发到本地 wrangler dev（先另开终端运行 npx wrangler dev，端口 8787）
    proxy: {
      '/ws': {
        target: 'ws://127.0.0.1:8787',
        ws: true,
        changeOrigin: true,
      },
    },
  },
})
