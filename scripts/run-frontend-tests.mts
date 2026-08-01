import { readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const scriptsDir = resolve(process.cwd(), 'scripts')
const excludedScripts = new Map([
  ['test-profile-prompt-visibility.mts', '直接读取 src-tauri 后端源码'],
])

const allowedFailures = new Map([])

const scripts = readdirSync(scriptsDir)
  .filter(name => /^test-.*\.mts$/.test(name))
  .filter(name => name !== 'test-profile-prompt-visibility.mts')
  .sort()

const summarize = (value: unknown) => {
  const text = String(value ?? '').trim().replace(/\s+/g, ' ')
  if (!text) return '(empty)'
  return text.length > 240 ? `${text.slice(0, 237)}...` : text
}

let failed = false
for (const name of scripts) {
  const scriptPath = resolve(scriptsDir, name)
  const result = spawnSync(process.execPath, [...process.execArgv, scriptPath], {
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
