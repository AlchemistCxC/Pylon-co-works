// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { highlightCode, highlightCodeBuiltin } from '../codeHighlight.ts'
import { hasHighlightLanguage } from '../lezerHighlight.ts'

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
