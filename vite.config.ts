import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  server: { proxy: { '/api': 'http://127.0.0.1:3001' } },
  // 保留符号链接路径（本机通过 junction 以 ASCII 路径构建，避免中文真实路径的编码问题）
  resolve: {
    preserveSymlinks: true,
  },
})
