#!/usr/bin/env node
// P60 施工书 §5.2 门禁：clippy「相对基线零新增」。
//
// 用法：
//   cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --message-format=json > clippy.json
//   node scripts/check-clippy-baseline.mjs clippy.json artifacts/clippy-baseline.json
//
// 语义：
//   - 基线文件不存在 → 写入当前诊断作为基线，退出 0（首次建立基线）；
//   - 基线文件存在 → 任何「基线中没有的诊断指纹」都判定为本片新增，退出 1；
//     消失的诊断只作为 info 报告。
//
// 指纹 = code | 仓库相对文件 | 诊断消息（不含行号/列号，避免无关行位移造成噪声）。
// 同一诊断会在 lib 与 test target 各报一次，这里按指纹去重——门禁只关心
// 「新增了什么」，不关心同一诊断被重复编译几次。

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

const diagnostics = new Set()
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
  const file = message.spans?.[0]?.file_name
    ? relativeFile(message.spans[0].file_name)
    : '<unknown>'
  diagnostics.add(`${code} | ${file} | ${message.message}`)
}

const sorted = [...diagnostics].sort((a, b) => a.localeCompare(b))
const absoluteBaseline = resolve(root, baselinePath)

if (!existsSync(absoluteBaseline)) {
  mkdirSync(dirname(absoluteBaseline), { recursive: true })
  writeFileSync(
    absoluteBaseline,
    `${JSON.stringify(
      {
        version: 2,
        note: 'P60 clippy baseline (relative: zero new diagnostics, deduped by fingerprint)',
        diagnostics: sorted,
      },
      null,
      2,
    )}\n`,
  )
  process.stdout.write(
    `${JSON.stringify({ mode: 'write', baseline: baselinePath, diagnostics: diagnostics.size }, null, 2)}\n`,
  )
  process.exit(0)
}

const baseline = (() => {
  try {
    const parsed = JSON.parse(readFileSync(absoluteBaseline, 'utf8'))
    // v1 基线用 counts（指纹 → 次数）；v2 用去重后的数组。两者都接受。
    if (Array.isArray(parsed.diagnostics)) return new Set(parsed.diagnostics)
    return new Set(Object.keys(parsed.counts ?? {}))
  } catch (error) {
    console.error(`clippy baseline is not valid JSON: ${absoluteBaseline}\n${error.message}`)
    process.exit(2)
  }
})()

const added = sorted.filter((fingerprint) => !baseline.has(fingerprint))
const removed = [...baseline].filter((fingerprint) => !diagnostics.has(fingerprint))

process.stdout.write(
  `${JSON.stringify(
    {
      mode: 'check',
      baseline: baselinePath,
      current: diagnostics.size,
      baselineCount: baseline.size,
      added,
      removed,
    },
    null,
    2,
  )}\n`,
)
if (added.length > 0) {
  console.error(`check-clippy-baseline FAILED: ${added.length} new diagnostic(s)`)
  process.exitCode = 1
}
