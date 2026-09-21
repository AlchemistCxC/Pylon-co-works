// @vitest-environment jsdom
/**
 * issue #220 WP4 · markdown 计算核 parity 门禁。
 *
 * 对比面：markdown 侧自 #220 切流起，`markdownRenderModel.ts` **就是** Rust 计算核
 * （comrak），现场解析结果对快照即「产品路径 vs 快照」的一致性门禁；高亮侧保留
 * starry-night 基线（`starryCore.ts`）对 Rust（syntect）的逐 token 差分。corpus 见
 * `src-tauri/pylon-markdown/parity/corpus.json`。
 *
 * 两侧产物的职责划分：
 * - `rust-snapshot.json`：宿主 bin `parity_snapshot` 从 Rust 纯内层导出的快照
 *   （需要 Rust 工具链才能再生，vitest 只读）；
 * - `ts-baseline.json`：`parity/dump-ts.mjs` 在 bun 下生成的 TS 基线快照；
 * - `parity-report.json`：`parity/diff.mjs` 对比两侧快照生成的分类清单
 *   （aligned / divergent）。
 *
 * 断言语义（这是门禁而不是快照测试）：
 * - **aligned** case：TS 现场解析结果必须与 Rust 快照**深相等**——任何一侧引擎
 *   行为漂移都会在这里红。高亮自 D2/D3/D5 收口后（Rust 使用与 starry-night
 *   同源的 vendored 语法 + vscode-textmate 主题算法移植 + github `pl-*` 类名）
 *   已是**逐 token parity**，不再是「形状对齐」；
 * - **divergent** case：断言两侧**仍然不相等**——已过审的边缘差异（脚注、js/go
 *   的引擎级残差）不允许静默消失或静默漂移，要变化必须显式更新清单；
 * - 高亮另锁**出口形状不变量**：整块进 / 行数组出、每行 span 文本拼回原行。
 *
 * 快照再生（需要 Rust 工具链，见 parity/ 目录内脚本头注释）：
 *   cargo run -p pylon-markdown --bin parity_snapshot -- \
 *     pylon-markdown/parity/corpus.json pylon-markdown/parity/rust-snapshot.json
 *   bun src-tauri/pylon-markdown/parity/dump-ts.mjs \
 *     src-tauri/pylon-markdown/parity/corpus.json src-tauri/pylon-markdown/parity/ts-baseline.json
 *   node src-tauri/pylon-markdown/parity/diff.mjs <rust> <ts> <report>
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { createStarryNight } from '../../../../components/chat/starryCore.ts'
import { toHtml } from 'hast-util-to-html'
import type { Grammar } from '@wooorm/starry-night'
import { clearMarkdownRenderModelCache, getMarkdownRenderModel, type MarkdownRoot } from '../markdownRenderModel.ts'

// 路径相对 vitest 的 cwd（仓库根）——与 ChatView.css.test.ts 同一口径。
const parityDir = 'src-tauri/pylon-markdown/parity'
const corpus = JSON.parse(readFileSync(`${parityDir}/corpus.json`, 'utf8')) as {
  markdown: ReadonlyArray<{ id: string, input: string }>
  highlight: ReadonlyArray<{ id: string, language: string, code: string }>
}
/** Rust 高亮出口形状（`HighlightedLine` 的 JSON 镜像，见 pylon-markdown/src/highlight.rs）。 */
interface RustHighlightedLine {
  readonly spans: ReadonlyArray<{ readonly classes: ReadonlyArray<string>, readonly text: string }>
}
const rustSnapshot = JSON.parse(readFileSync(`${parityDir}/rust-snapshot.json`, 'utf8')) as {
  markdown: ReadonlyArray<{ id: string, model: unknown }>
  highlight: ReadonlyArray<{ id: string, language: string, lines: ReadonlyArray<RustHighlightedLine> | null, endsWithNewline: boolean }>
}
// ts-baseline.json 的 markdown 部分由 diff.mjs 消费；测试侧 TS 基线一律现场解析，
// 高亮 token 部分也现场驱动 starry（见 highlightHast），保证对比面是「活代码」。
const report = JSON.parse(readFileSync(`${parityDir}/parity-report.json`, 'utf8')) as {
  aligned: ReadonlyArray<{ kind: string, id: string }>
  divergent: ReadonlyArray<{ kind: string, id: string, reason?: string }>
}

const rustMarkdownById = new Map(rustSnapshot.markdown.map(item => [item.id, item.model]))
const rustHighlightById = new Map(rustSnapshot.highlight.map(item => [item.id, item]))
const corpusMarkdownById = new Map(corpus.markdown.map(item => [item.id, item.input]))
const markdownAligned = report.aligned.filter(item => item.kind === 'markdown')
const markdownDivergent = report.divergent.filter(item => item.kind === 'markdown')
const highlightAligned = report.aligned.filter(item => item.kind === 'highlight')
const highlightDivergent = report.divergent.filter(item => item.kind === 'highlight')

// 与 TS 基线 codeHighlight.ts 的 GRAMMAR_LOADERS 同表——经 starryCore 包装模块
// 动态导入，避免拖入全量语法集。
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
const LANGUAGE_SCOPES: Record<string, string> = {
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
const highlighters = new Map<string, Promise<Awaited<ReturnType<typeof createStarryNight>>>>()

/** hast root 的最小结构镜像（避免引入 hast 类型依赖）。 */
interface HastNode {
  type: string
  value?: string
  children?: HastNode[]
  properties?: { className?: unknown }
}

async function highlightHast(language: string, code: string): Promise<HastNode | null> {
  const scope = LANGUAGE_SCOPES[language.toLowerCase()]
  const load = scope && GRAMMAR_LOADERS[scope]
  if (!scope || !load) return null
  let highlighter = highlighters.get(scope)
  if (!highlighter) {
    highlighter = load().then(async ({ default: grammar }) =>
      createStarryNight([grammar], {
        // vitest（Node）下没有 vite 的 ?url 资源，经 createRequire 解析本地 onig.wasm
        // （S1-CSP 的本地化原则在测试环境同样适用：不 fetch 远程 CDN）。
        getOnigurumaUrlFetch: () => new URL(createRequire(import.meta.url).resolve('vscode-oniguruma/release/onig.wasm')),
      })
    )
    highlighters.set(scope, highlighter)
  }
  const starry = await highlighter
  return starry.highlight(code, scope) as unknown as HastNode
}

/** hast → 扁平 token 序列（与 parity/dump-ts.mjs 的 flattenTokens 同一语义）。 */
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

/**
 * Rust 行数组 → 扁平 token 序列。行数组出口不含换行；starry 的 hast 构建把换行
 * 当 root 下的无类文本追加并跨行合并无类文本，这里按同一语义在行间补 '\n'
 * （规则与 parity/diff.mjs 的 flattenRustLines 一致，两边改要一起改）。
 */
function flattenRustLines(item: { lines: ReadonlyArray<RustHighlightedLine> | null, endsWithNewline: boolean }): Array<{ scope: string, text: string }> | null {
  if (!item.lines) return null
  const toToken = (span: RustHighlightedLine['spans'][number]) => ({
    scope: (span.classes ?? []).join(' '),
    text: span.text,
  })
  const rows = item.lines.map(line => line.spans.map(toToken))
  const out: Array<{ scope: string, text: string }> = []
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
  if (item.endsWithNewline) {
    const last = out[out.length - 1]
    if (last && last.scope === '') last.text += '\n'
    else out.push({ scope: '', text: '\n' })
  }
  return out
}

async function parseWithBaseline(input: string): Promise<MarkdownRoot> {
  clearMarkdownRenderModelCache()
  // cache:false + incremental:false = 绕过 LRU 与增量 graft 的纯解析路径（parity 对比面）。
  return getMarkdownRenderModel(input, { cache: false, incremental: false })
}

describe('220 WP4 · markdown 计算核 parity（aligned 清单）', () => {
  it(`corpus 覆盖完整性：快照与 corpus 的 markdown case 一一对应（${corpus.markdown.length} 条）`, () => {
    expect(rustSnapshot.markdown).toHaveLength(corpus.markdown.length)
    for (const item of rustSnapshot.markdown) {
      expect(corpusMarkdownById.has(item.id)).toBe(true)
    }
  })

  it(`aligned case 两侧深相等（${markdownAligned.length} 条）`, async () => {
    expect(markdownAligned.length).toBeGreaterThan(100)
    const mismatches: Array<{ id: string, reason: string }> = []
    for (const { id } of markdownAligned) {
      const input = corpusMarkdownById.get(id)
      const rust = rustMarkdownById.get(id)
      if (input === undefined || rust === undefined) throw new Error(`清单引用了不存在的 case: ${id}`)
      const ts = await parseWithBaseline(input)
      if (!equals(ts, rust)) mismatches.push({ id, reason: 'TS 现场解析与 Rust 快照不一致' })
    }
    expect(mismatches).toEqual([])
  })

  it('divergent case 随 TS 基线退役收敛为计算核形状（footnote-probe）', async () => {
    // 历史差异（remark-gfm 的 user-content-fn-* 锚点 + 文末 section 重排 vs comrak
    // 脚注形状）曾按「两侧仍不相等」看守。#220 切流后 unified 基线已退役，渲染模型
    // **就是**计算核输出——该 case 的断言翻转为「与 Rust 快照一致」：comrak 形状成为
    // 唯一形状，防止它被静默改掉；清单里的 divergent 记录保留作历史档案。
    expect(markdownDivergent.map(item => item.id)).toEqual(['footnote-probe'])
    for (const { id } of markdownDivergent) {
      const input = corpusMarkdownById.get(id)
      const rust = rustMarkdownById.get(id)
      if (input === undefined || rust === undefined) throw new Error(`清单引用了不存在的 case: ${id}`)
      const model = await parseWithBaseline(input)
      expect(equals(model, rust)).toBe(true)
    }
  })
})

describe('220 WP4 · 高亮计算核 parity（逐 token）', () => {
  it('整块进 / 行数组出：Rust 每行 span 文本拼回输入（不含换行）、行数一致', () => {
    for (const item of corpus.highlight) {
      const snapshot = rustHighlightById.get(item.id)
      const lines = snapshot?.lines
      if (lines === null || lines === undefined) continue // 语法缺失记录为差异，见下一条
      expect(lines, item.id).toHaveLength(item.code.replace(/\n$/, '').split('\n').length)
      const joined = lines.map(line => line.spans.map((span: { text: string }) => span.text).join('')).join('\n')
      expect(joined, item.id).toBe(item.code.replace(/\n$/, ''))
    }
  })

  it(`aligned case 逐 token 深相等（${highlightAligned.length}/${corpus.highlight.length} 条）`, async () => {
    // D2/D3/D5 收口后：Rust 用同源 vendored 语法 + starry 类名层，绝大多数语言
    // 逐 token 一致。此处现场跑 TS 基线高亮并与 Rust 扁平 token 深比较。
    expect(highlightAligned.length).toBeGreaterThan(corpus.highlight.length / 2)
    for (const { id } of highlightAligned) {
      const item = corpus.highlight.find(candidate => candidate.id === id)
      const snapshot = rustHighlightById.get(id)
      if (item === undefined || snapshot === undefined) throw new Error(`清单引用了不存在的 case: ${id}`)
      const hast = await highlightHast(item.language, item.code)
      expect(hast, id).not.toBeNull()
      const ts = flattenTsTokens(hast!)
      const rust = flattenRustLines(snapshot)
      expect(rust, id).not.toBeNull()
      expect(equals(ts, rust), id).toBe(true)
    }
  })

  it(`已过审差异清单：${highlightDivergent.length} 条，两侧输出仍不相等`, async () => {
    // 剩余差异是 syntect/fancy-regex 与 vscode-textmate/oniguruma 的引擎级残差
    // （\G 续匹配锚、capture 级子 patterns、lookbehind 细节），逐条过审见
    // parity-report.json 与 WP4 开发记录。断言差异**仍在**，防静默漂移。
    expect(highlightDivergent.map(item => item.id).sort()).toEqual(['js', 'yaml'])
    for (const { id } of highlightDivergent) {
      const item = corpus.highlight.find(candidate => candidate.id === id)
      const snapshot = rustHighlightById.get(id)
      if (item === undefined || snapshot === undefined) throw new Error(`清单引用了不存在的 case: ${id}`)
      const hast = await highlightHast(item.language, item.code)
      const ts = flattenTsTokens(hast!)
      const rust = flattenRustLines(snapshot)
      expect(equals(ts, rust), id).toBe(false)
    }
  })

  it('出口 HTML 形状：TS toHtml(starry.highlight) 与 Rust 类名链语义同构（抽样）', async () => {
    // 抽 rust 一例：TS HTML 里的 pl-k span 文本集合 = Rust 里 pl-k span 文本集合。
    const item = corpus.highlight.find(candidate => candidate.id === 'rust')
    const snapshot = rustHighlightById.get('rust')
    expect(item && snapshot?.lines).toBeTruthy()
    const hast = await highlightHast(item!.language, item!.code)
    const tsHtml = toHtml(hast as Parameters<typeof toHtml>[0])
    const rustClasses = new Set(
      snapshot!.lines!.flatMap(line => line.spans.flatMap(span => span.classes))
    )
    expect(rustClasses.has('pl-k')).toBe(true)
    expect(tsHtml).toContain('pl-k')
  })
})

/** 深相等（键序无关）；与 diff.mjs 的 firstDiff 同一比较语义。 */
function equals(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => equals(item, b[index]))
  }
  const recordA = a as Record<string, unknown>
  const recordB = b as Record<string, unknown>
  const keysA = Object.keys(recordA)
  const keysB = Object.keys(recordB)
  if (keysA.length !== keysB.length) return false
  return keysA.every(key => Object.hasOwn(recordB, key) && equals(recordA[key], recordB[key]))
}

// ── 边界编组：`parseMarkdown` 的**出口形状**（#220 收口轮补的门禁盲区） ─────────────
//
// 原有两条断言都看不见「边界怎么编组」：Rust 侧快照走 `serde_json`（纯对象），
// 现场解析走产品路径（`normalizeNode` 会把 `Map` 归一成对象）。于是**`properties` 被
// 编成 JS `Map` 这件事在这道门禁里是隐形的**——直到脚手架拿「边界原始产物」逐字节比对
// 才暴露：`JSON.stringify(properties)` 得到 `{}`，链接丢 href、代码块丢 language
// class、任务列表丢 checked。这里直接钉边界产物：`properties` 必须是**普通对象**，
// 且关键元素带对了键。
describe('220 WP4 · parseMarkdown 边界编组（properties 必须是普通对象）', () => {
  const boundaryCases: ReadonlyArray<readonly [string, string, readonly string[]]> = [
    ['[链接](https://example.com)', 'a', ['href']],
    ['```ts\nconst x = 1\n```', 'code', ['className']],
    ['- [x] 已完成', 'input', ['type', 'checked', 'disabled']],
    ['![图](https://example.com/a.png)', 'img', ['src', 'alt']],
  ]

  it('properties 是普通对象（不是 Map）且带对关键键', async () => {
    const { loadMarkdownCompute } = await import('../../../../infrastructure/compute/markdownCompute.ts')
    const compute = await loadMarkdownCompute()
    for (const [markdown, tagName, expectedKeys] of boundaryCases) {
      const tree = compute.parseMarkdown(markdown) as { children?: unknown[] }
      const found: Record<string, unknown>[] = []
      const walk = (node: unknown): void => {
        if (!node || typeof node !== 'object') return
        const record = node as { tagName?: string; properties?: unknown; children?: unknown[] }
        if (record.tagName === tagName && record.properties !== undefined) {
          found.push(record.properties as Record<string, unknown>)
        }
        for (const child of record.children ?? []) walk(child)
      }
      walk(tree)
      expect(found.length, `${markdown} 应含 <${tagName}>`).toBeGreaterThan(0)
      for (const properties of found) {
        // Map 会被 JSON.stringify 抹成 {}，所以「序列化后非空」等价于「真的是普通对象且有键」。
        expect(Object.getPrototypeOf(properties), `${markdown} 的 properties 应是普通对象`).toBe(Object.prototype)
        for (const key of expectedKeys) {
          expect(properties, `${markdown} 的 <${tagName}> 缺 ${key}`).toHaveProperty(key)
        }
        expect(JSON.parse(JSON.stringify(properties))).toEqual(properties)
      }
    }
  })
})
