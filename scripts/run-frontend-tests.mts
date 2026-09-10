import { readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const scriptsDir = resolve(process.cwd(), 'scripts')
const excludedScripts = new Map([
  ['test-profile-prompt-visibility.mts', '直接读取 src-tauri 后端源码'],
  // 已迁入 Vitest 直跑（*.test.mts），不再作为 standalone 脚本 spawn：
  ['test-session-runtime-store.test.mts', '已迁入 Vitest'],
  ['test-session-runtime-store-fuzz.test.mts', '已迁入 Vitest'],
  ['test-replay-state.test.mts', '已迁入 Vitest'],
  ['test-replay-termination.test.mts', '已迁入 Vitest'],
  ['test-replay-tool-settlement.test.mts', '已迁入 Vitest'],
  ['test-chat-regression-contract.test.mts', '已迁入 Vitest'],
  ['test-settings-layout.test.mts', '已迁入 Vitest'],
  ['test-sheet-persistence.mts', '已由 test-sheet-persistence.test.mts 在 Vitest 中执行'],
  ['test-sheet-persistence.test.mts', '已迁入 Vitest'],
  ['test-normalizer.mts', '依赖完整 TypeScript 转译，已迁入 Vitest 兼容套件'],
  ['test-session-runtime.mts', '依赖完整 TypeScript 转译，已迁入 Vitest 兼容套件'],
  ['test-compact-transaction.mts', '依赖完整 TypeScript 转译，已迁入 Vitest 兼容套件'],
  ['test-sheet-persistence-v2.mts', '依赖完整 TypeScript 转译，已迁入 Vitest 兼容套件'],
  ['test-tool-presentation-model.mts', '依赖完整 TypeScript 转译，已迁入 Vitest 兼容套件'],
  ['test-sheet-registry.mts', '依赖完整 TypeScript 转译，已迁入 Vitest 兼容套件'],
  ['test-tool-renderer-registry.mts', '依赖完整 TypeScript 转译，已迁入 Vitest 兼容套件'],
  ['test-sheet-state.mts', '依赖完整 TypeScript 转译，已迁入 Vitest 兼容套件'],
])

const allowedFailures = new Map([])

const scripts = readdirSync(scriptsDir)
  .filter(name => /^test-.*\.mts$/.test(name))
  .filter(name => !excludedScripts.has(name))
  .sort()

const summarize = (value: unknown) => {
  const text = String(value ?? '').trim().replace(/\s+/g, ' ')
  if (!text) return '(empty)'
  return text.length > 240 ? `${text.slice(0, 237)}...` : text
}

let failed = false
for (const name of scripts) {
  const scriptPath = resolve(scriptsDir, name)
  // P46：bun 宿主下 execPath 即 bun，原生执行 .mts；不再透传 Node 专属 flag 与 loader
  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: process.cwd(),
    encoding: 'utf8',
  })
  const exitCode = typeof result.status === 'number' ? result.status : 1
  if (exitCode !== 0 && !allowedFailures.has(name)) failed = true
  if (result.error) failed = true

  console.log(`[frontend-test] ${name}`)
  console.log(`  exit code: ${exitCode}`)
  console.log(`  stdout: ${summarize(result.stdout)}`)
  console.log(`  stderr: ${summarize(result.stderr || result.error?.message)}`)
  if (allowedFailures.has(name)) {
    console.log(`  baseline: allowed failure (${allowedFailures.get(name)})`)
  }
}

for (const [name, reason] of excludedScripts) {
  console.log(`[frontend-test] excluded: ${name} (${reason})`)
}

for (const [name, reason] of allowedFailures) {
  console.log(`[frontend-test] allowed baseline failure: ${name} (${reason})`)
}

process.exitCode = failed ? 1 : 0
