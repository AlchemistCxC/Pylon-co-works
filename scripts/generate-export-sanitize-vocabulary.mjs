#!/usr/bin/env node
// generate-export-sanitize-vocabulary — 把 export Strip 脱敏词表从 Rust 单源生成到 TS。
//
// 为什么需要它：export 语义敏感 key 表原本在 TS（threeSourceExport.ts
// isSensitiveExportKey）逐条手抄一份（#444 现状调查：两侧碰巧一致但无门禁，
// Rust 侧加一个敏感词，前端取证导出就漏脱敏）。#444 批次②按 dev-standards
// 「跨语言契约的单源方向」以 Rust 为单源，本脚本把 TS 侧变成派生物。
//
// 为什么不 `cargo run` 取值：同 generate-retention-policy.mjs 的取舍——
// 不把 cargo 拖进纯前端门禁链，直接读 sanitize.rs 里 is_export_sensitive_key
// 函数体的字面量（exact 名单 / ends_with 后缀 / contains 规则三组）。
// 锚点写得紧：函数缺失、matches! 块缺失、函数体内出现三组之外的字面量即
// **报错退出**——新增规则形态必须显式接入本脚本，绝不吐出看似正常的短表。
//
// 值正则（SENSITIVE_KEY_PATTERN / BARE_SECRET_PATTERN）有意不生成：Rust regex
// 与 JS 方言有差异，两侧字面量一致性由 scripts/sanitize-vocabulary.test.mts
// 的 JS 重放门禁看守。
//
// 用法：
//   node scripts/generate-export-sanitize-vocabulary.mjs           # 写文件
//   node scripts/generate-export-sanitize-vocabulary.mjs --check   # 只校验是否已同步

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE = join(root, 'src-tauri', 'pylon-foundations', 'src', 'sanitize.rs')
const TARGET = join(root, 'src', 'domains', 'export', 'canonicalExportSanitizeVocabulary.generated.ts')
const FN_SIGNATURE = 'pub fn is_export_sensitive_key'

/** 从 signature 起找首个 '{'，做花括号深度扫描取平衡块（词表字面量为简单标识符，无转义）。 */
function extractBraceBlock(source, signature) {
  const start = source.indexOf(signature)
  if (start < 0) return ''
  const open = source.indexOf('{', start)
  if (open < 0) return ''
  let depth = 0
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    if (source[i] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(start, i + 1)
    }
  }
  return ''
}

/** 从 block 起做圆括号深度扫描（内容为简单字符串列表，字符串内无括号）。 */
function extractParenBlock(block, signature) {
  const start = block.indexOf(signature)
  if (start < 0) return ''
  let depth = 0
  for (let i = start + signature.length - 1; i < block.length; i += 1) {
    if (block[i] === '(') depth += 1
    if (block[i] === ')') {
      depth -= 1
      if (depth === 0) return block.slice(start, i + 1)
    }
  }
  return ''
}

/** 紧邻 signature 上方的连续 `///` 文档块。 */
function extractDocLines(source, signature) {
  const declaration = source.indexOf(signature)
  if (declaration < 0) return []
  const lines = source.slice(0, declaration).split('\n')
  const docLines = []
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const trimmed = lines[i].trim()
    if (trimmed.startsWith('///')) {
      docLines.unshift(trimmed.replace(/^\/\/\/\s?/, ''))
    } else if (docLines.length === 0 && (trimmed === '' || trimmed.startsWith('#['))) {
      continue
    } else {
      break
    }
  }
  return docLines
}

/** 剥离 Rust 注释（块注释 + 行注释），防函数体内注释里的规则形状文本被收割为规则。
 *  朴素剥离不识别字符串内的 `//`/`/*`——词表函数体字面量为简单标识符，不出现该形状；
 *  若未来出现，剥离产生的残缺字面量会被残留检查红灯兜底。 */
function stripRustComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

/** 抓取并解析 is_export_sensitive_key：exact 名单 + 后缀规则 + contains 规则。 */
export function readExportSanitizeVocabulary() {
  const source = readFileSync(SOURCE, 'utf8')
  const fnBody = stripRustComments(extractBraceBlock(source, FN_SIGNATURE))
  if (!fnBody) {
    throw new Error(`未找到 ${FN_SIGNATURE} 函数体锚点：${SOURCE}`)
  }
  const matchesBlock = extractParenBlock(fnBody, 'matches!(')
  if (!matchesBlock) {
    throw new Error(`${FN_SIGNATURE} 缺少 matches!(...) exact 名单——写法变了，请更新本脚本而不是接受派生错误`)
  }
  const exact = [...matchesBlock.matchAll(/"([^"\n]+)"/g)].map(match => match[1])
  if (exact.length === 0) {
    throw new Error(`matches! 块内未解析到任何 exact 词表字面量：${SOURCE}`)
  }

  // 函数体内每一条 "..." 字面量都必须被三组规则之一消费：
  // 出现残留字面量 = 新规则形态（starts_with 等、或非小写形状的新词）未接入，
  // 宁可红灯不可静默漏词。形状放开到任意 "..."，防数字开头/连字符/大写形状漏网。
  let residual = fnBody.replace(matchesBlock, '')
  const suffixes = []
  const contains = []
  for (const match of residual.matchAll(/\.(ends_with|contains)\("([^"\n]+)"\)/g)) {
    ;(match[1] === 'ends_with' ? suffixes : contains).push(match[2])
    residual = residual.replace(match[0], '')
  }
  const residualLiterals = [...residual.matchAll(/"[^"\n]*"/g)].map(match => match[0])
  if (residualLiterals.length > 0) {
    throw new Error(
      `${FN_SIGNATURE} 内存在三组规则（exact/ends_with/contains）之外的字面量：` +
        `${residualLiterals[0]}——新规则形态请显式接入本脚本`,
    )
  }
  if (suffixes.length === 0 || contains.length === 0) {
    throw new Error(`ends_with/contains 规则解析为空（suffixes=${suffixes.length}, contains=${contains.length}）——写法变了，请更新本脚本`)
  }

  return { exact, suffixes, contains, docLines: extractDocLines(source, FN_SIGNATURE) }
}

function renderArray(name, doc, items) {
  const lines = items.map(item => `  '${item}',`)
  return `/** ${doc}\n */\nexport const ${name} = [\n${lines.join('\n')}\n] as const`
}

function render({ exact, suffixes, contains, docLines }) {
  const doc = docLines.length > 0 ? docLines.map(line => `// ${line}`.trimEnd()).join('\n') : `// ${FN_SIGNATURE}`
  return `// 本文件由 scripts/generate-export-sanitize-vocabulary.mjs 生成，**禁止手改**。
//
// 单源：src-tauri/pylon-foundations/src/sanitize.rs 的 is_export_sensitive_key
//（#444 批次②：export Strip 词表以 Rust 为单源，TS 侧由脚本生成）。
// 改词表请改 Rust 侧，然后跑 \`bun run build:export-sanitize-vocabulary\`；
// \`bun run check:export-sanitize-vocabulary\` 会在不同步时报红。
// 值正则有意不生成（Rust regex 与 JS 方言差异），两侧字面量一致性由
// scripts/sanitize-vocabulary.test.mts 门禁看守。
//
// 单源函数文档：
${doc}

${renderArray('EXPORT_SANITIZE_EXACT_KEYS', 'exact 命中即整个 key 剔除（Strip 策略，大小写不敏感）。', exact)}

${renderArray('EXPORT_SANITIZE_SUFFIXES', '后缀命中即剔除（tokensTotal 等统计键不误伤）。', suffixes)}

${renderArray('EXPORT_SANITIZE_CONTAINS', 'contains 命中即剔除（覆盖 client_secret/clientSecret 形态）。', contains)}
`
}

function main() {
  const check = process.argv.includes('--check')
  const vocabulary = readExportSanitizeVocabulary()
  const expected = render(vocabulary)

  if (check) {
    if (!existsSync(TARGET)) {
      console.error(`[export-sanitize-vocabulary] 缺少生成物：${TARGET}`)
      console.error('[export-sanitize-vocabulary] 修复：bun run build:export-sanitize-vocabulary')
      process.exit(1)
    }
    if (readFileSync(TARGET, 'utf8') !== expected) {
      console.error('[export-sanitize-vocabulary] TS 词表与 Rust 单源不同步。')
      console.error('[export-sanitize-vocabulary] 修复：bun run build:export-sanitize-vocabulary')
      process.exit(1)
    }
    console.log(`[export-sanitize-vocabulary] 与 Rust 单源一致（exact ${vocabulary.exact.length} / 后缀 ${vocabulary.suffixes.length} / contains ${vocabulary.contains.length}）`)
    return
  }

  writeFileSync(TARGET, expected)
  console.log(`[export-sanitize-vocabulary] 已生成 ${vocabulary.exact.length + vocabulary.suffixes.length + vocabulary.contains.length} 条规则 → ${TARGET.slice(root.length + 1)}`)
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main()
}
