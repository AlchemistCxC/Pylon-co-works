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

// 高亮：两侧现在都是 (classes 链, text) 扁平 token 序列。TS 侧 flattenTokens 产
// `{scope: 类名链 join ' ', text}`；Rust 侧行数组按同一形状扁平化。
//
// 差异：starry 的 hast 构建会把**换行符**作为 root 下的无类文本节点追加，相邻的
// 无类文本会跨行合并成一个 text 节点；Rust 的行数组形状无法表达跨行合并。因此
// Rust 扁平化时按 starry 的 appendText 语义在行间插入 '\n'：
//   - 前行末 token 无类 且 次行首 token 无类 → 合并（text 中补 '\n'）；
//   - 仅一侧无类 → '\n' 并入无类一侧；
//   - 两侧皆有类 → 插入独立的无类 '\n' token。
// 末行以换行结尾时同样补一个（或并入）无类 '\n' token。此规则与 vitest 门禁
// （markdownComputeParity.test.ts 的 flattenRustLines）保持一致，两边改要一起改。
function flattenRustLines(item) {
  if (!item.lines) return null
  const toToken = span => ({
    scope: (span.classes ?? []).join(' '),
    text: span.text,
  })
  const rows = item.lines.map(line => line.spans.map(toToken))
  const out = []
  for (const row of rows) {
    if (out.length === 0) {
      out.push(...row)
      continue
    }
    const last = out[out.length - 1]
    const first = row[0]
    const lastPlain = last && last.scope === ''
    const firstPlain = first && first.scope === ''
    if (lastPlain && firstPlain) {
      last.text += '\n' + first.text
      out.push(...row.slice(1))
    } else if (lastPlain) {
      last.text += '\n'
      out.push(...row)
    } else if (firstPlain) {
      out.push({ scope: '', text: '\n' + first.text }, ...row.slice(1))
    } else {
      out.push({ scope: '', text: '\n' }, ...row)
    }
  }
  // 块以换行结尾：补上 starry 追加的最后一个换行文本节点（并入无类尾 token）。
  if (item.endsWithNewline) {
    const last = out[out.length - 1]
    if (last && last.scope === '') {
      last.text += '\n'
    } else {
      out.push({ scope: '', text: '\n' })
    }
  }
  return out
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
