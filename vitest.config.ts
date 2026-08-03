import { defineConfig } from 'vitest/config'

// 前端测试：
// - scripts/*.test.mts：历史形态（顶层 assert + console.log），node 环境
// - src/**/*.test.{ts,tsx}：组件行为测试（@testing-library/react），文件内
//   用 `// @vitest-environment jsdom` 声明 jsdom 环境
// 迁移期间保留原 run-frontend-tests.mts runner 作为兼容入口；vitest 为正式门禁。
export default defineConfig({
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
    },
  },
})
