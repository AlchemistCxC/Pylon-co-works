import { defineConfig } from 'vite'
import solid from 'vite-plugin-solid'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = fileURLToPath(new URL('.', import.meta.url))
const SOLID_WORKBENCH_FILES = /src\/renderers\/solid-workbench\/.*\.solid\.tsx$/

export default defineConfig({
  root: projectRoot,
  plugins: [solid({ include: SOLID_WORKBENCH_FILES })],
  build: {
    outDir: resolve(projectRoot, 'dist-solid-smoke'),
    emptyOutDir: true,
    rollupOptions: {
      input: resolve(projectRoot, 'solid-workbench-smoke.html'),
      output: {
        entryFileNames: 'assets/solid-smoke-[hash].js',
        chunkFileNames: 'assets/solid-chunk-[hash].js',
      },
    },
  },
})
