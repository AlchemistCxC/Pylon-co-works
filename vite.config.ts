import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import solid from 'vite-plugin-solid'

const SOLID_WORKBENCH_FILES = /src\/renderers\/solid-workbench\/.*\.solid(?:\.test)?\.tsx$/

export default defineConfig({
  plugins: [
    solid({ include: SOLID_WORKBENCH_FILES }),
    react({ exclude: SOLID_WORKBENCH_FILES }),
  ],
  server: {
    port: 5173,
    strictPort: true,
  },
  envPrefix: ['VITE_', 'TAURI_'],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          const normalizedId = id.replace(/\\/g, '/')
          const firstPartyPackage = normalizedId.match(/src\/plugins\/product\/packages\/(builtin\.pylon-[^/]+)\//)?.[1]
          if (firstPartyPackage) return `first-party-${firstPartyPackage.replace('builtin.', '')}`
          if (/src\/plugins\/product\/(productPluginIds|firstPartyProductPackage|sharedLogicalActivation)\.ts$/.test(normalizedId)) {
            return 'first-party-pylon-shared'
          }
          // 首屏必需的大依赖拆独立 vendor chunk，让应用主 chunk 保持轻量（< 600 kB）
          // Match the normalized path as well as first-party packages.  Vite
          // can hand Rollup Windows-style ids; testing the raw `id` made the
          // vendor split platform-dependent and silently inflated the app
          // chunk on Windows builds.
          if (/node_modules\/(react|react-dom|scheduler)\//.test(normalizedId)) return 'vendor-react'
          if (/node_modules\/(motion|motion-dom|framer-motion)\//.test(normalizedId)) return 'vendor-motion'
        },
      },
    },
  },
})
