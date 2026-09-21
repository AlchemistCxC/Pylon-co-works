// ─────────────────────────────────────────────────────────────────────────────
// 【TS 高亮基线驱动】starry-night（issue #220 WP4 的高亮 TS 侧）。
//
// 组装来源（诚实声明）：
// - `LANGUAGE_SCOPES` / `GRAMMAR_LOADERS` / starry-night 装配（含 onig.wasm 本地
//   解析）逐字取自 `src/components/chat/codeHighlight.ts@76cbc819^` 的同名表与
//   `src/renderers/solid-workbench/chat/__tests__/markdownComputeParity.test.ts`
//   的 `highlightHast`（后者是 vitest/Node 下已验证可跑的装配口径）；
// - `flattenTsTokens` 逐字取自同一测试文件（hast → 扁平 token 序列，
//   与 parity/dump-ts.mjs 的 flattenTokens 同一语义）；
// - 出口 `highlightTs(code, language)` 返回 `{ scope, text }[] | null`——
//   `null` 语义 = 语言未知/语法包缺失（与 wasm `highlightBlock` 的 undefined 对位）。
//
// 仅服务 `scripts/compute-parity/` 脚手架，不在任何生产路径。
// ─────────────────────────────────────────────────────────────────────────────

import { createRequire } from 'node:module'

import { createStarryNight } from '../../../src/components/chat/starryCore.ts'
import type { Grammar } from '@wooorm/starry-night'

/** 与 TS 基线 codeHighlight.ts 的 LANGUAGE_SCOPES 同表（逐字）。 */
export const LANGUAGE_SCOPES: Record<string, string> = {
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

/** 与 TS 基线 codeHighlight.ts 的 GRAMMAR_LOADERS 同表（逐字；经 starryCore 按需取语法）。 */
const GRAMMAR_LOADERS: Record<string, () => Promise<{ default: Grammar }>> = {
  'source.js': () => import('@wooorm/starry-night/source.js'),
  'source.ts': () => import('@wooorm/starry-night/source.ts'),
  'source.tsx': () => import('@wooorm/starry-night/source.tsx'),
  'source.python': () => import('@wooorm/starry-night/source.python'),
  'source.rust': () => import('@wooorm/starry-night/source.rust'),
  'source.go': () => import('@wooorm/starry-night/source.go'),
  'source.java': () => import('@wooorm/starry-night/source.java'),
  'source.c': () => import('@wooorm/starry-night/source.c'),
  'source.c++': () => import('@wooorm/starry-night/source.c++'),
  'source.css': () => import('@wooorm/starry-night/source.css'),
  'source.json': () => import('@wooorm/starry-night/source.json'),
  'source.yaml': () => import('@wooorm/starry-night/source.yaml'),
  'source.shell': () => import('@wooorm/starry-night/source.shell'),
  'text.html.basic': () => import('@wooorm/starry-night/text.html.basic'),
}

/** scope → 语言别名反查（corpus 生成用；基线本体不含）。 */
export function languageForScope(scope: string): string | undefined {
  for (const [language, candidate] of Object.entries(LANGUAGE_SCOPES)) {
    if (candidate === scope) return language
  }
  return undefined
}

const highlighters = new Map<string, Promise<Awaited<ReturnType<typeof createStarryNight>>>>()

/** hast root 的最小结构镜像（避免引入 hast 类型依赖）。 */
interface HastNode {
  type: string
  value?: string
  children?: HastNode[]
  properties?: { className?: unknown }
}

export interface TsToken {
  readonly scope: string
  readonly text: string
}

async function highlightHast(language: string, code: string): Promise<HastNode | null> {
  const scope = LANGUAGE_SCOPES[language.toLowerCase()]
  const load = scope && GRAMMAR_LOADERS[scope]
  if (!scope || !load) return null
  let highlighter = highlighters.get(scope)
  if (!highlighter) {
    highlighter = load().then(async ({ default: grammar }) =>
      createStarryNight([grammar], {
        // Node/vitest 下没有 vite 的 ?url 资源，经 createRequire 解析本地 onig.wasm
        // （S1-CSP 的本地化原则在测试环境同样适用：不 fetch 远程 CDN）。
        getOnigurumaUrlFetch: () => new URL(createRequire(import.meta.url).resolve('vscode-oniguruma/release/onig.wasm')),
      })
    )
    highlighters.set(scope, highlighter)
  }
  const starry = await highlighter
  return starry.highlight(code, scope) as unknown as HastNode
}

/** hast → 扁平 token 序列（逐字取自 markdownComputeParity.test.ts 的 flattenTsTokens）。 */
function flattenTsTokens(node: HastNode, inherited: ReadonlyArray<string> = [], out: Array<{ scope: string, text: string }> = []): Array<{ scope: string, text: string }> {
  if (node.type === 'text') {
    if (node.value && node.value.length > 0) out.push({ scope: inherited.join(' '), text: node.value })
    return out
  }
  const className = node.properties?.className
  const classes = [...inherited, ...(Array.isArray(className) ? className.map(String) : [])]
  for (const child of node.children ?? []) flattenTsTokens(child, classes, out)
  return out
}

/** TS 基线高亮出口：扁平 token 序列；语言未知/语法包缺失返回 null。 */
export async function highlightTs(code: string, language: string): Promise<TsToken[] | null> {
  const hast = await highlightHast(language, code)
  if (!hast) return null
  return flattenTsTokens(hast)
}
