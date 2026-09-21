// 脚手架本地 vitest 配置：绕过共享 globalSetup 的 wasm 重建检查。
//
// 为什么存在：根 `vitest.config.ts` 的 globalSetup（scripts/vitest-wasm-setup.mts）
// 在 crate 源码哈希变化时会跑 wasm-pack 重建——crate 上有**他人的在途改动**且尚未
// 编通过时（AGENTS.md §2.1：共享工作树的在途改动不归脚手架管），重建会失败并挡住
// 测试。本配置针对**既有产物**跑对照，显式 opt-in：
//
//   npx vitest run --config scripts/compute-parity/vitest.config.ts
//
// 默认门禁仍走根配置（「产物必须新鲜」不弱化，issue #220 纪律）；产物陈旧的
// 责任在调用方。
import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vitest/config'

export default defineConfig({
  root: fileURLToPath(new URL('../..', import.meta.url)),
  test: {
    globalSetup: [],
    include: ['scripts/compute-parity.test.mts', 'scripts/probe-tmp.test.mts'],
    environment: 'node',
    setupFiles: ['vitest.setup.ts'],
    pool: 'forks',
    testTimeout: 120_000,
  },
})
