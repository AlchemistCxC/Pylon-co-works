#!/usr/bin/env node
// P60 施工书 §5.2 门禁：clippy「相对基线零新增」。
//
// 用法：
//   cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --message-format=json > clippy.json
//   node scripts/check-clippy-baseline.mjs clippy.json artifacts/clippy-baseline.json
//
// 语义：
//   - 基线文件不存在 → 写入当前诊断作为基线，退出 0（首次建立基线）；
//   - 基线文件存在 → 任何「基线中没有的诊断指纹」或「同一指纹出现次数超过基线」
//     都判定为本片新增，退出 1；消失的诊断只作为 info 报告。
//
// 指纹 = code | 仓库相对文件 | 诊断消息（不含行号/列号，避免无关行位移造成噪声）。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve, relative } from 'node:path'
import { fileURLToPath, URL } from 'node:url'
import console from 'node:console'
import process from 'node:process'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const [clippyPath, baselinePath] = process.argv.slice(2)
if (!clippyPath || !baselinePath) {
  console.error('usage: node scripts/check-clippy-baseline.mjs <clippy.json> <baseline.json>')
  process.exit(2)
}

const relativeFile = (path) => relative(root, resolve(path)).replaceAll('\\', '/')

const counts = new Map()
for (const line of readFileSync(resolve(root, clippyPath), 'utf8').split('\n')) {
  const trimmed = line.trim()
  if (!trimmed.startsWith('{')) continue
  let payload
  try {
    payload = JSON.parse(trimmed)
  } catch {
    continue
  }
  const message = payload?.message
  if (!message || (message.level !== 'error' && message.level !== 'warning')) continue
  const code = message.code?.code ?? `rustc-${message.level}`
  const file = message.spans?.[0]?.file_name ? relativeFile(message.spans[0].file_name) : '<unknown>'
  const fingerprint = `${code} | ${file} | ${message.message}`
  counts.set(fingerprint, (counts.get(fingerprint) ?? 0) + 1)
}

const current = Object.fromEntries([...counts.entries()].sort(([a], [b]) => a.localeCompare(b)))
const absoluteBaseline = resolve(root, baselinePath)

if (!existsSync(absoluteBaseline)) {
  mkdirSync(dirname(absoluteBaseline), { recursive: true })
  writeFileSync(
    absoluteBaseline,
    `${JSON.stringify({ version: 1, note: 'P60 clippy baseline (relative: zero new diagnostics)', counts: current }, null, 2)}\n`,
  )
  process.stdout.write(`${JSON.stringify({ mode: 'write', baseline: baselinePath, diagnostics: counts.size }, null, 2)}
`)
  process.exit(0)
}

const baseline = (() => {
  try {
    return JSON.parse(readFileSync(absoluteBaseline, 'utf8')).counts ?? {}
  } catch (error) {
    console.error(`clippy baseline is not valid JSON: ${absoluteBaseline}\n${error.message}`)
    process.exit(2)
  }
})()
const added = []
const increased = []
for (const [fingerprint, count] of counts) {
  const before = baseline[fingerprint] ?? 0
  if (before === 0) added.push(fingerprint)
  else if (count > before) increased.push(`${fingerprint} (${before} -> ${count})`)
}
const removed = Object.keys(baseline).filter((fingerprint) => !counts.has(fingerprint))

process.stdout.write(
  `${JSON.stringify(
    { mode: 'check', baseline: baselinePath, current: counts.size, baselineCount: Object.keys(baseline).length, added, increased, removed },
    null,
    2,
  )}
`,
)
if (added.length > 0 || increased.length > 0) {
  console.error(`check-clippy-baseline FAILED: ${added.length} new, ${increased.length} increased`)
  process.exitCode = 1
}
