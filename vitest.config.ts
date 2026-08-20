import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import solid from 'vite-plugin-solid'

const SOLID_WORKBENCH_FILES = /src\/renderers\/solid-workbench\/.*\.solid(?:\.test)?\.tsx$/

// 前端测试：
// - scripts/*.test.mts：历史形态（顶层 assert + console.log），node 环境
// - src/**/*.test.{ts,tsx}：组件行为测试；文件内可用环境注释声明 jsdom
// - Solid renderer 只转换 *.solid.tsx，其他 *.tsx 继续走 React transform
// 迁移期间保留原 run-frontend-tests.mts runner 作为兼容入口；vitest 为正式门禁。
export default defineConfig({
  plugins: [
    solid({ include: SOLID_WORKBENCH_FILES, hot: false }),
    react({ exclude: SOLID_WORKBENCH_FILES }),
  ],
  test: {
    include: ['scripts/*.test.mts', 'src/**/*.test.{ts,tsx}'],
    environment: 'node',
    setupFiles: ['vitest.setup.ts'],
    testTimeout: 30000,
    pool: 'forks',
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      exclude: ['src/**/*.test.{ts,tsx}', 'src/components/chat/chatMockData.ts'],
      reporter: ['text', 'json-summary'],
      // ISSUE-20 W4：从真实基线开始（实测 statements 60.89 / branches 46.73 /
      // functions 61.32 / lines 63.22），阈值取基线下方留余量避免 flake；
      // 按 domain 渐进提高，不为追数字写空测试。
      thresholds: {
        statements: 58,
        branches: 44,
        functions: 59,
        lines: 61,
      },
    },
  },
})
