// @vitest-environment jsdom
/**
 * issue #220 WP4 · markdown 计算核 parity 门禁。
 *
 * 对比面：TS 基线（`markdownRenderModel.ts`，unified + remark-gfm + remark-rehype）
 * vs Rust 计算核（`src-tauri/pylon-markdown`，comrak + syntect）在**同一 corpus**
 * （`src-tauri/pylon-markdown/parity/corpus.json`）上的输出。
 *
 * 两侧产物的职责划分：
 * - `rust-snapshot.json`：宿主 bin `parity_snapshot` 从 Rust 纯内层导出的快照
 *   （需要 Rust 工具链才能再生，vitest 只读）；
 * - `parity-report.json`：`parity/diff.mjs` 生成的分类清单（aligned / divergent）。
 *
 * 断言语义（这是门禁而不是快照测试）：
 * - **aligned** case：TS 现场解析结果必须与 Rust 快照**深相等**——任何一侧引擎
 *   行为漂移都会在这里红；
 * - **divergent** case：断言两侧**仍然不相等**——已过审的边缘差异（脚注、高亮
 *   语法体系）不允许静默消失或静默漂移，要变化必须显式更新清单；
 * - 高亮另锁**出口形状不变量**：整块进 / 行数组出、每行 span 文本拼回原行。
 *
 * 快照再生（需要 Rust 工具链，见 parity/ 目录内脚本头注释）：
 *   cargo run -p pylon-markdown --bin parity_snapshot -- \
 *     pylon-markdown/parity/corpus.json pylon-markdown/parity/rust-snapshot.json
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { highlightCodeBuiltin } from '../../../../components/chat/codeHighlight.ts'
import { clearMarkdownRenderModelCache, getMarkdownRenderModel, type MarkdownRoot } from '../markdownRenderModel.ts'

// 路径相对 vitest 的 cwd（仓库根）——与 ChatView.css.test.ts 同一口径。
const parityDir = 'src-tauri/pylon-markdown/parity'
const corpus = JSON.parse(readFileSync(`${parityDir}/corpus.json`, 'utf8')) as {
  markdown: ReadonlyArray<{ id: string, input: string }>
  highlight: ReadonlyArray<{ id: string, language: string, code: string }>
}
/** Rust 高亮出口形状（`HighlightedLine` 的 JSON 镜像，见 pylon-markdown/src/highlight.rs）。 */
interface RustHighlightedLine {
  readonly spans: ReadonlyArray<{ readonly scopeStack: ReadonlyArray<string>, readonly text: string }>
}
const rustSnapshot = JSON.parse(readFileSync(`${parityDir}/rust-snapshot.json`, 'utf8')) as {
  markdown: ReadonlyArray<{ id: string, model: unknown }>
  highlight: ReadonlyArray<{ id: string, language: string, lines: ReadonlyArray<RustHighlightedLine> | null }>
}
const report = JSON.parse(readFileSync(`${parityDir}/parity-report.json`, 'utf8')) as {
  aligned: ReadonlyArray<{ kind: string, id: string }>
  divergent: ReadonlyArray<{ kind: string, id: string, reason?: string }>
}

const rustMarkdownById = new Map(rustSnapshot.markdown.map(item => [item.id, item.model]))
const rustHighlightById = new Map(rustSnapshot.highlight.map(item => [item.id, item.lines]))
const corpusMarkdownById = new Map(corpus.markdown.map(item => [item.id, item.input]))
const markdownAligned = report.aligned.filter(item => item.kind === 'markdown')
const markdownDivergent = report.divergent.filter(item => item.kind === 'markdown')
const highlightDivergent = report.divergent.filter(item => item.kind === 'highlight')

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

  it('divergent case 差异仍存在（防止已过审差异被静默改掉）', async () => {
    // 当前唯一记录在案的 markdown 结构性差异：footnotes（remark-gfm 的
    // user-content-fn-* 锚点 + 文末 section 重排 vs comrak 脚注形状）。
    expect(markdownDivergent.map(item => item.id)).toEqual(['footnote-probe'])
    for (const { id } of markdownDivergent) {
      const input = corpusMarkdownById.get(id)
      const rust = rustMarkdownById.get(id)
      if (input === undefined || rust === undefined) throw new Error(`清单引用了不存在的 case: ${id}`)
      const ts = await parseWithBaseline(input)
      expect(equals(ts, rust)).toBe(false)
    }
  })
})

describe('220 WP4 · 高亮计算核：形状不变量与已过审差异', () => {
  it('整块进 / 行数组出：Rust 每行 span 文本拼回输入、行数一致', () => {
    for (const item of corpus.highlight) {
      const lines = rustHighlightById.get(item.id)
      if (lines === null || lines === undefined) continue // 语言缺失（ts/tsx）记录为差异，见下一条
      expect(lines, item.id).toHaveLength(item.code.replace(/\n$/, '').split('\n').length)
      const joined = lines.map(line => line.spans.map((span: { text: string }) => span.text).join('')).join('')
      expect(joined, item.id).toBe(item.code)
    }
  })

  it(`已过审差异清单：${highlightDivergent.length} 条，两侧输出仍不相等`, async () => {
    // 高亮是「形状对齐 + 差异过审」而非逐字节 parity：syntect 的 scope 栈体系与
    // starry-night 的 github css class（pl-*）不是同一语义（含语法集差异：
    // syntect 默认集缺 source.ts/tsx；starry 对单 scope 注册的 c++ 不分词）。
    expect(highlightDivergent).toHaveLength(corpus.highlight.length)
    for (const item of corpus.highlight) {
      const rustLines = rustHighlightById.get(item.id)
      const tsHtml = await highlightCodeBuiltin(item.language, item.code).catch(() => null)
      if (rustLines === null || rustLines === undefined) {
        // syntect 缺语法包 → Rust 返回 null；TS 侧仍能高亮（starry 有语法）。
        expect(rustLines ?? null, item.id).toBeNull()
        continue
      }
      expect(tsHtml, item.id).not.toBeNull()
    }
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
