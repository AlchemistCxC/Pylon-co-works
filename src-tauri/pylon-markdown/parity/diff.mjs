// WP4 parity 差异报告生成器。
//
// 用法（仓库根执行）：
//   node src-tauri/pylon-markdown/parity/diff.mjs <rust-snapshot.json> <ts-baseline.json> <out-report.json>
//
// 逐 case 深比较两侧输出，产出：
//   - 人类可读清单（stdout）：一致 case 计数 + 每条差异的 id、首个分歧 JSON 路径、两侧值；
//   - 机器可读报告（out-report.json）：aligned / divergent 分类，供 vitest parity 测试消费
//     （aligned 侧断言深相等，divergent 侧断言**仍然不相等**——防差异静默消失或漂移）。

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const [rustPath, tsPath, outPath] = process.argv.slice(2)
if (!rustPath || !tsPath || !outPath) {
  console.error('用法: diff.mjs <rust-snapshot.json> <ts-baseline.json> <out-report.json>')
  process.exit(2)
}
const rust = JSON.parse(readFileSync(path.resolve(rustPath), 'utf8'))
const ts = JSON.parse(readFileSync(path.resolve(tsPath), 'utf8'))

/** 深比较，返回首个分歧路径（null = 相等）。 */
function firstDiff(a, b, prefix = '$') {
  if (a === b) return null
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
    return `${prefix}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`
  }
  if (Array.isArray(a) !== Array.isArray(b)) return `${prefix}: array/object 类型分歧`
  const keys = Array.isArray(a)
    ? a.map((_, i) => String(i))
    : Object.keys(a).filter(key => Object.hasOwn(b, key))
  if (Array.isArray(a)) {
    if (a.length !== b.length) return `${prefix}: 数组长度 ${a.length} != ${b.length}`
  } else {
    const onlyA = Object.keys(a).filter(key => !Object.hasOwn(b, key))
    const onlyB = Object.keys(b).filter(key => !Object.hasOwn(a, key))
    if (onlyA.length > 0) return `${prefix}.${onlyA[0]}: 仅 TS 侧有此键`
    if (onlyB.length > 0) return `${prefix}.${onlyB[0]}: 仅 Rust 侧有此键`
  }
  for (const key of keys) {
    const diff = firstDiff(a[key], b[key], `${prefix}.${key}`)
    if (diff) return diff
  }
  return null
}

const aligned = []
const divergent = []
const lines = []

function compare(kind, rustCases, tsCases, pick) {
  const tsById = new Map(tsCases.map(item => [item.id, item]))
  for (const rustCase of rustCases) {
    const tsCase = tsById.get(rustCase.id)
    if (!tsCase) {
      divergent.push({ kind, id: rustCase.id, reason: 'corpus 两侧不对齐' })
      continue
    }
    const a = pick(tsCase)
    const b = pick(rustCase)
    const diff = firstDiff(a, b)
    if (diff === null) {
      aligned.push({ kind, id: rustCase.id })
    } else {
      divergent.push({ kind, id: rustCase.id, reason: diff, ts: a, rust: b })
      lines.push(`[${kind}] ${rustCase.id}\n  首个分歧: ${diff}`)
    }
  }
}

compare('markdown', rust.markdown, ts.markdown, item => item.model)
// 高亮两侧形状不同名但同构：TS tokens = (className join, text) 扁平序列；
// Rust lines → 扁平化成 (scopeStack join ' ', text)。语法体系不同（github css class
// vs TextMate scope 栈），逐 token 不等是预期，报告用于差异清单举证。
function flattenRustLines(item) {
  if (!item.lines) return null
  return item.lines.flatMap(line => line.spans).map(span => ({ scope: span.scopeStack.join(' '), text: span.text }))
}
compare('highlight', rust.highlight, ts.highlight, item => item.lines ? flattenRustLines(item) : item.tokens)

console.log(`markdown: ${aligned.filter(x => x.kind === 'markdown').length} 一致 / ${divergent.filter(x => x.kind === 'markdown').length} 不一致`)
console.log(`highlight: ${aligned.filter(x => x.kind === 'highlight').length} 一致 / ${divergent.filter(x => x.kind === 'highlight').length} 不一致`)
if (lines.length > 0) {
  console.log('\n== 差异清单 ==\n' + lines.join('\n'))
} else {
  console.log('无差异。')
}

writeFileSync(path.resolve(outPath), `${JSON.stringify({ aligned, divergent }, null, 2)}\n`)
console.log(`报告 → ${path.resolve(outPath)}`)
