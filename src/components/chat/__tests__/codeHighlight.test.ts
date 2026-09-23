// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { highlightCode, highlightCodeBuiltin } from '../codeHighlight.ts'
import { hasHighlightLanguage, highlightBlockWithLezer } from '../lezerHighlight.ts'

describe('code highlight builtin', () => {
  it('resolves common file languages to grammars', () => {
    expect(hasHighlightLanguage('typescript')).toBe(true)
    expect(hasHighlightLanguage('rust')).toBe(true)
  })

  it('returns syntax markup for a TypeScript source', async () => {
    const html = await highlightCodeBuiltin('typescript', 'const answer: number = 42')
    expect(html).toContain('const')
    expect(html).toMatch(/class="pl-[^"]+"/)
  })
})

// 以下行为锁迁移自 scripts/test-code-highlight.mts（P91 A2 下沉）：
// 原脚本是源码 token 断言（Node 加载不了 onig.wasm 时代的替代品），vitest 能真跑高亮后改为行为验证。
// #241/ADR-0020：语言门与引擎都换成 Lezer——门从「TextMate scope 表」改为「有没有对应语言包」，
// 别名集合不变（同一批 24 个），故这里锁的是**同一件事的等价判据**。
describe('语言别名覆盖（同步门）', () => {
  it('常见语言别名都有语言包', () => {
    expect(hasHighlightLanguage('ts')).toBe(true)
    expect(hasHighlightLanguage('python')).toBe(true)
    expect(hasHighlightLanguage('sh')).toBe(true)
    expect(hasHighlightLanguage('jsx')).toBe(true)
    expect(hasHighlightLanguage('html')).toBe(true)
  })

  it('未知语言不在覆盖内', () => {
    expect(hasHighlightLanguage('unknown')).toBe(false)
  })
})

describe('highlightCode 未知语言', () => {
  it('scope 或 loader 缺失时返回 null', async () => {
    await expect(highlightCode('unknown-language', 'const x = 1')).resolves.toBeNull()
  })
})

describe('grammar loaders 全量真实加载', () => {
  // 原 STRUCTURE GUARD 锁「GRAMMAR_LOADERS 覆盖 14 个 scope」；行为等价锁 =
  // 每个语言真实走完高亮管线（缺 loader/语言包时这里会红），能分词的语言再锁 pl-* 标记。
  it.each([
    ['js', 'function f() { return 1 }'],
    ['ts', 'const answer: number = 42'],
    ['tsx', 'const el = <div className="a" />'],
    ['python', 'def main():\n    return 1'],
    ['rust', 'fn main() { let x: u32 = 1; }'],
    ['go', 'func main() { fmt.Println("hi") }'],
    ['java', 'class A { void b() {} }'],
    ['c', 'int main(void) { return 0; }'],
    ['css', '.term-root { color: red; }'],
    ['json', '{"key": [1, 2, null]}'],
    ['yaml', 'root:\n  - item: 1'],
    ['bash', 'echo "$HOME"'],
    ['html', '<!DOCTYPE html><html><body>hi</body></html>'],
  ])('%s 源码产生语法标记', async (language, code) => {
    const html = await highlightCode(language, code)
    expect(html).not.toBeNull()
    expect(html!).toMatch(/class="pl-[^"]"/)
  })

  // #241/ADR-0020 的**有意分叉**：换 Lezer 前这条是「cpp 管线不崩但不分词」的已知限制
  //（旧实现每语法独立 SyntaxSet ⇒ cpp 顶层 include 的 source.c 未注册 ⇒ 静默零分词）。
  // Lezer 的 lang-cpp 自带 C++ 基础语法，cpp 现在**真的着色**，限制随之消失，断言升级为正向。
  it('cpp 现在会真正着色（换 Lezer 后原有的「零分词」限制消失）', async () => {
    const html = await highlightCode('cpp', 'int main() { return 0; }')
    expect(html).not.toBeNull()
    expect(html!).toMatch(/class="pl-[^"]"/)
  })
})

describe('highlightCode 缓存与 pending 去重', () => {
  it('并发同 key 调用共享同一结果，重复调用命中缓存', async () => {
    const code = 'export const dedupe = (a: number) => a * 2'
    const [a, b] = await Promise.all([highlightCode('ts', code), highlightCode('ts', code)])
    expect(a).not.toBeNull()
    expect(b).toBe(a)
    const cached = await highlightCode('ts', code)
    expect(cached).toBe(a)
  })
})

// #241 回归：`syntaxTree(state)` 对「不在编辑器视图里的 state」只做**分段同步解析**，树停在第
// 一个同步块（本机实测 3006 字符）⇒ 超出的部分**静默丢色**。症状在表上极不显眼（块越大单位成本
// 越低），是在 #233 基准里读出来的（见 issue #241 的评论）；修复 = 先改 `ensureSyntaxTree`
// 整段解析（刀5），再改为**按时间切片 + 片间让出**的解析（刀6，见下一组用例）。
//
// 本组用「尾部必须有色」而不是「总色数」做判据：截断的特征恰恰是**后半段标记数为 0**，
// 而总数断言在截断点抬高的实现下会假绿。
describe('大块整段着色（回归：同步解析上限截断）', () => {
  const unit = 'export function sample(list: readonly string[]): number {\n'
    + '  const mapped = list.map(item => item.length)\n'
    + '  return mapped.reduce((a, b) => a + b, 0)\n'
    + '}\n\n'
  const block = (chars: number) => unit.repeat(Math.ceil(chars / unit.length)).slice(0, chars)

  it.each([6_000, 20_000])('长度 %i 的 ts 块，末段同样带 pl-* 标记', async (chars) => {
    const html = await highlightCode('ts', block(chars))
    expect(html).not.toBeNull()
    const lines = html!.split('\n')
    expect(lines.length).toBeGreaterThan(50)
    const tail = lines.slice(Math.floor(lines.length * 2 / 3)).join('\n')
    expect(tail).toMatch(/class="pl-[^"]/)
  })
})

// #241 刀6：解析改成「按时间切片 + 片间让出主线程」之后，有两条性质要锁住：
// ① **预算再小也不截断**（截断正是 #241 那个静默丢色缺陷的形状）；② 小区块**不为让出付成本**。
// 两条都用**注入**验证（让出函数可注入 + 分片预算可调），不依赖计时抖动。
describe('解析切片：不截断、片间让出', () => {
  const unit = 'export function sample(list: readonly string[]): number {\n'
    + '  const mapped = list.map(item => item.length)\n'
    + '  return mapped.reduce((a, b) => a + b, 0)\n'
    + '}\n\n'
  const block = (chars: number) => unit.repeat(Math.ceil(chars / unit.length)).slice(0, chars)
  /** 末段是否有色——判据同上一组：截断的特征就是后半段一个标记都没有。 */
  const tailHasClass = (lines: readonly { spans: readonly { classes: readonly string[], text: string }[] }[]) => {
    const cut = Math.floor(lines.length * 2 / 3)
    return lines.slice(cut).some(line => line.spans.some(span => span.classes.length > 0 && span.text.trim() !== ''))
  }

  it('把分片预算压到 1ms（60k 的块必然超出）依然整段着色，且确实发生了让出', async () => {
    let yields = 0
    const lines = await highlightBlockWithLezer(block(60_000), 'ts', {
      sliceBudgetMs: 1,
      yieldToEventLoop: async () => { yields += 1 },
    })
    expect(lines).toBeDefined()
    expect(lines!.length).toBeGreaterThan(500)
    expect(yields).toBeGreaterThan(0)
    expect(tailHasClass(lines!)).toBe(true)
  })

  it('超过旧的 200ms 总预算也不再截断（500k 的块整段有色）', async () => {
    const lines = await highlightBlockWithLezer(block(500_000), 'ts')
    expect(lines).toBeDefined()
    expect(tailHasClass(lines!)).toBe(true)
  }, 20_000)

  it('小区块不为让出付成本：解析在片内完成，让出零次', async () => {
    // 先跑一次把引擎装载与 JIT 预热掉，否则首调可能自己就超出一个分片
    await highlightBlockWithLezer('const warm: number = 1\n', 'ts')
    let yields = 0
    await highlightBlockWithLezer('const x: number = 1\n', 'ts', { yieldToEventLoop: async () => { yields += 1 } })
    expect(yields).toBe(0)
  })

  it('让出与否不影响结果：注入让出的产出与默认路径逐行一致', async () => {
    const code = block(60_000)
    const injected = await highlightBlockWithLezer(code, 'ts', { sliceBudgetMs: 1, yieldToEventLoop: async () => {} })
    const normal = await highlightBlockWithLezer(code, 'ts')
    expect(injected).toEqual(normal)
  })
})
