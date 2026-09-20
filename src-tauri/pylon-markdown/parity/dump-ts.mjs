// WP4 parity 的 TS 侧基线 dump（bun 运行）。
//
// 用法（仓库根执行）：
//   bun src-tauri/pylon-markdown/parity/dump-ts.mjs <corpus.json> <out.json>
//
// 与 vitest parity 测试的区别：本脚本在 vitest 之外跑，用于**开发期差分迭代**——
// 产出与 Rust 快照（parity_snapshot bin）同构的 JSON，交给 diff.mjs 出差异清单。
// 为什么不 import codeHighlight.ts：它顶部有 vite 专属的 `?url` 资源导入，bun 无法
// 解析；这里直接用 starryCore（纯 re-export）+ 本文件内的 LANGUAGE_SCOPES 副本
// （与 codeHighlight.ts 同表，两侧退役后此副本即为多余，差异清单过审时说明）。
// 语言映射若有漂移，vitest parity 测试会经 scopeForLanguage 常驻对齐。

import { readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { getMarkdownRenderModel } from '../../../src/renderers/solid-workbench/chat/markdownRenderModel.ts'
import { createStarryNight } from '../../../src/components/chat/starryCore.ts'
import { toHtml } from 'hast-util-to-html'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '../../..')

const [corpusPath = 'src-tauri/pylon-markdown/parity/corpus.json', outPath = 'src-tauri/pylon-markdown/parity/ts-baseline.json'] = process.argv.slice(2)
const corpus = JSON.parse(readFileSync(path.resolve(corpusPath), 'utf8'))

// ── markdown 侧：走 TS 基线完整管线（unified + remark-gfm + remark-rehype）。
// cache:false + incremental:false = 绕过 LRU 与增量 graft 的纯解析路径（parity 对比面）。
const markdown = []
for (const item of corpus.markdown) {
  const model = await getMarkdownRenderModel(item.input, { cache: false, incremental: false })
  markdown.push({ id: item.id, model })
}

// ── 高亮侧：直接驱动 starry-night（与 codeHighlight.ts 同一引擎、同一 scope 表）。
const LANGUAGE_SCOPES = {
  js: 'source.js', javascript: 'source.js', jsx: 'source.js',
  ts: 'source.ts', typescript: 'source.ts', tsx: 'source.tsx',
  py: 'source.python', python: 'source.python',
  rs: 'source.rust', rust: 'source.rust',
  go: 'source.go', java: 'source.java',
  c: 'source.c', cpp: 'source.c++', cxx: 'source.c++',
  css: 'source.css', json: 'source.json', yaml: 'source.yaml', yml: 'source.yaml',
  sh: 'source.shell', shell: 'source.shell', bash: 'source.shell',
  html: 'text.html.basic', markup: 'text.html.basic',
}
const require = createRequire(path.join(repoRoot, 'package.json'))
const onigUrl = pathToFileURL(require.resolve('vscode-oniguruma/release/onig.wasm'))
const highlighterCache = new Map()
async function highlightHast(code, scope) {
  let highlighter = highlighterCache.get(scope)
  if (!highlighter) {
    const { default: grammar } = await import(`@wooorm/starry-night/${scope}`)
    highlighter = await createStarryNight([grammar], { getOnigurumaUrlFetch: () => onigUrl })
    highlighterCache.set(scope, highlighter)
  }
  return highlighter.highlight(code, scope)
}

// hast → 扁平 token 序列（(className join ' '), text），保留先序。
function flattenTokens(node, inherited = [], out = []) {
  if (node.type === 'text') {
    if (node.value.length > 0) out.push({ scope: inherited.join(' '), text: node.value })
    return out
  }
  const classes = [...inherited, ...(Array.isArray(node.properties?.className) ? node.properties.className : [])]
  for (const child of node.children ?? []) flattenTokens(child, classes, out)
  return out
}

const highlight = []
for (const item of corpus.highlight) {
  const scope = LANGUAGE_SCOPES[String(item.language).toLowerCase()]
  if (!scope) {
    highlight.push({ id: item.id, language: item.language, tokens: null, html: null })
    continue
  }
  const hast = await highlightHast(item.code, scope)
  highlight.push({
    id: item.id,
    language: item.language,
    tokens: flattenTokens(hast),
    html: toHtml(hast),
  })
}

writeFileSync(path.resolve(outPath), `${JSON.stringify({ generator: 'ts-baseline (unified + remark-gfm + remark-rehype / starry-night)', markdown, highlight }, null, 2)}\n`)
console.log(`dump-ts: ${markdown.length} markdown + ${highlight.length} highlight → ${path.resolve(outPath)}`)
