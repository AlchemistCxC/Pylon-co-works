import { globSync, readFileSync } from 'node:fs'
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import solid from 'vite-plugin-solid'

const SOLID_WORKBENCH_FILES = /src\/renderers\/solid-workbench\/.*\.solid(?:\.test)?\.tsx$/

// Preserve the environment declared by each test; directory names do not imply DOM use.
const testFiles = [...globSync(['scripts/*.test.mts', 'src/**/*.test.{ts,tsx}'])]
  .map(file => file.replaceAll('\\', '/')).sort()
function testGroup(file: string): 'node' | 'node-shared' | 'react-dom' | 'react-shared' | 'solid-dom' {
  const source = readFileSync(file, 'utf8')
  if (!/@(?:vitest|jest)-environment\s+jsdom/.test(source)) {
    return /\bvi\.(?:mock|doMock|unmock|doUnmock)\s*\(/.test(source) ? 'node' : 'node-shared'
  }
  // These React hosts mount Solid roots and share Solid's runtime lifetime.
  const solidHost = file === 'src/components/__tests__/SettingsPreview.solidMigration.test.tsx'
    || file === 'src/sheets/__tests__/AgentSheetView.rendererMode.test.tsx'
  if (file.endsWith('.solid.test.tsx') || solidHost) return 'solid-dom'
  return /\bvi\.(?:mock|doMock|unmock|doUnmock)\s*\(/.test(source) ? 'react-dom' : 'react-shared'
}

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
    projects: (['node', 'node-shared', 'react-dom', 'react-shared', 'solid-dom'] as const).map(name => ({
      plugins: [
        solid({ include: SOLID_WORKBENCH_FILES, hot: false }),
        react({ exclude: SOLID_WORKBENCH_FILES }),
      ],
      test: {
        name,
        include: testFiles.filter(file => testGroup(file) === name),
        environment: name.startsWith('node') ? 'node' : 'jsdom',
        setupFiles: ['vitest.setup.ts'],
        // Node suites include source-contract tests that intentionally replace
        // module mocks; keep their module registry per file.
        // Node pure logic suites have no DOM lifecycle and are safe to share;
        // DOM suites retain file isolation because async UI effects can outlive
        // a test file even after cleanup.
        isolate: name !== 'node-shared',
        pool: 'forks',
        testTimeout: 30_000,
      },
    })),
    // P91 C2 §7：全局 60s 收紧为 30s（node 纯逻辑/jsdom 组件共用一档；esbuild/dist
    // 重型 integration 文件内用 vi.setConfig 个别放宽到 60s）。retry 已退役——
    // 出口判据：无 retry 连续 5 轮全量全绿。
    testTimeout: 30_000,
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
