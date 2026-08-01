import { defineConfig } from 'vitest/config'

// 前端测试：scripts/test-*.mts（历史形态：顶层 assert + console.log 输出）。
// 迁移期间保留原 run-frontend-tests.mts runner 作为兼容入口；vitest 为正式门禁。
export default defineConfig({
  test: {
    include: ['scripts/*.test.mts'],
    environment: 'node',
    testTimeout: 30000,
    pool: 'forks',
  },
})
