// @vitest-environment jsdom
/**
 * issue #220 WP4 · markdown 计算核 parity 门禁（**#241 起只剩 markdown 半**）。
 *
 * 对比面：markdown 侧自 #220 切流起，`markdownRenderModel.ts` **就是** Rust 计算核
 * （comrak），现场解析结果对快照即「产品路径 vs 快照」的一致性门禁。corpus 见
 * `src-tauri/pylon-markdown/parity/corpus.json`。
 *
 * **高亮半已退役**（#241/ADR-0020）：高亮引擎从 wasm/syntect 换成前端 Lezer
 * （`src/components/chat/lezerHighlight.ts`），于是这条门禁原先依赖的三样东西一并退役——
 * starry-night TS 基线（`starryCore.ts` + `vite`/`onig.wasm` 解析）、`parity/dump-ts.mjs`、
 * `parity/diff.mjs` 与它们的产物 `ts-baseline.json` / `parity-report.json`；corpus 的
 * `highlight` 组也从 `corpus.json` 移除。高亮现在的对照面是 `codeHighlight.test.ts`
 * （14 语言真实管线 + cpp 正向断言）与实机验收。
 *
 * 产物职责（**只剩一份**）：
 * - `rust-snapshot.json`：宿主 bin `parity_snapshot` 从 Rust 纯内层导出的 markdown 快照
 *   （需要 Rust 工具链才能再生，vitest 只读）。
 *
 * 断言语义（门禁，不是快照测试）：**每个 case 的现场解析必须与快照深相等**——任何一侧
 * 行为漂移都会在这里红。原先按「两侧仍不相等」看守的 divergent 清单随 TS 基线退役而收敛：
 * 历史差异 `footnote-probe`（remark-gfm 的 `user-content-fn-*` 锚点 + 文末 section 重排）
 * 在切流后**就是**计算核形状，因此它已并入「必须相等」的那一批（见下）。
 *
 * 快照再生（需要 Rust 工具链）：
 *   cargo run -p pylon-markdown --bin parity_snapshot -- \
 *     pylon-markdown/parity/corpus.json pylon-markdown/parity/rust-snapshot.json
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { clearMarkdownRenderModelCache, getMarkdownRenderModel, type MarkdownRoot } from '../markdownRenderModel.ts'

// 路径相对 vitest 的 cwd（仓库根）——与 ChatView.css.test.ts 同一口径。
const parityDir = 'src-tauri/pylon-markdown/parity'
const corpus = JSON.parse(readFileSync(`${parityDir}/corpus.json`, 'utf8')) as {
  markdown: ReadonlyArray<{ id: string, input: string }>
}
const rustSnapshot = JSON.parse(readFileSync(`${parityDir}/rust-snapshot.json`, 'utf8')) as {
  markdown: ReadonlyArray<{ id: string, model: unknown }>
}

const rustMarkdownById = new Map(rustSnapshot.markdown.map(item => [item.id, item.model]))
const corpusMarkdownById = new Map(corpus.markdown.map(item => [item.id, item.input]))

async function parseWithBaseline(input: string): Promise<MarkdownRoot> {
  clearMarkdownRenderModelCache()
  // cache:false + incremental:false = 绕过 LRU 与增量 graft 的纯解析路径（parity 对比面）。
  return getMarkdownRenderModel(input, { cache: false, incremental: false })
}

describe('220 WP4 · markdown 计算核 parity', () => {
  it(`corpus 覆盖完整性：快照与 corpus 的 markdown case 一一对应（${corpus.markdown.length} 条）`, () => {
    expect(rustSnapshot.markdown).toHaveLength(corpus.markdown.length)
    for (const item of rustSnapshot.markdown) {
      expect(corpusMarkdownById.has(item.id)).toBe(true)
    }
  })

  it(`全部 case 现场解析与快照深相等（${corpus.markdown.length} 条）`, async () => {
    // 含历史 divergent 的 footnote-probe：TS 基线退役后 comrak 形状成为唯一形状，
    // 它与其余 116 条一样按「必须相等」看守（防静默改掉脚注投影形状）。
    const mismatches: Array<{ id: string, reason: string }> = []
    for (const { id } of corpus.markdown) {
      const input = corpusMarkdownById.get(id)
      const rust = rustMarkdownById.get(id)
      if (input === undefined || rust === undefined) throw new Error(`快照缺 case: ${id}`)
      const model = await parseWithBaseline(input)
      if (!equals(model, rust)) mismatches.push({ id, reason: '现场解析与 Rust 快照不一致' })
    }
    expect(mismatches).toEqual([])
  })
})

/** 深相等（键序无关）；与已退役 diff.mjs 的 firstDiff 同一比较语义。 */
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
