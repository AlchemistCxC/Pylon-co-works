import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
  },
  envPrefix: ['VITE_', 'TAURI_'],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          // 首屏必需的大依赖拆独立 vendor chunk，让应用主 chunk 保持轻量（< 600 kB）
          if (/node_modules\/(react|react-dom|scheduler)\//.test(id)) return 'vendor-react'
          if (/node_modules\/(motion|motion-dom|framer-motion)\//.test(id)) return 'vendor-motion'
        },
      },
    },
  },
})
