import { test } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { resolve } from 'node:path'

// 迁移兼容层：原 scripts/test-*.mts 是"顶层 assert + console.log"脚本形态，
// 不含 vitest suite。本文件在 vitest 内 spawn 原脚本（node --experimental-strip-types），
// 任一脚本非零退出即失败。随迁移推进，脚本改造成真 vitest 形态后从本文件移除。
// 排除项与原 run-frontend-tests.mts 一致：直接读取 src-tauri 的跨端脚本。

const scriptsDir = resolve(process.cwd(), 'scripts')
const EXCLUDED = new Set([
  'test-profile-prompt-visibility.mts',
  // 已迁入 Vitest 直跑（*.test.mts 由 vitest 自身收集，legacy-runner 不再 spawn）：
  'test-session-runtime-store.test.mts',
  'test-session-runtime-store-fuzz.test.mts',
  'test-replay-state.test.mts',
  'test-replay-termination.test.mts',
  'test-replay-tool-settlement.test.mts',
  'test-chat-regression-contract.test.mts',
  'test-settings-layout.test.mts',
])

const files = readdirSync(scriptsDir)
  .filter(f => /^test-.*\.mts$/.test(f))
  .filter(f => !EXCLUDED.has(f))
  .sort()

const GROUPS = 4
const groups: string[][] = Array.from({ length: GROUPS }, () => [])
files.forEach((f, i) => groups[i % GROUPS].push(f))

function runGroup(group: string[]) {
  const failures: string[] = []
  for (const f of group) {
    try {
      execFileSync(process.execPath, ['--experimental-strip-types', resolve(scriptsDir, f)], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      const err = error as { status?: number; stdout?: string; stderr?: string }
      const detail = String(err.stderr || err.stdout || '').trim().replace(/\s+/g, ' ').slice(0, 300)
      failures.push(`${f}: exit=${err.status} ${detail}`)
    }
  }
  if (failures.length > 0) {
    throw new Error(`legacy scripts failed (${failures.length}):\n${failures.join('\n')}`)
  }
}

for (let i = 0; i < GROUPS; i += 1) {
  test(`legacy scripts group ${i + 1}/${GROUPS} (${groups[i].length})`, () => runGroup(groups[i]), 180_000)
}
