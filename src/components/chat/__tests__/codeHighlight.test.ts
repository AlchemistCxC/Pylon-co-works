// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { highlightCode, highlightCodeBuiltin, scopeForLanguage } from '../codeHighlight.ts'

describe('code highlight builtin', () => {
  it('resolves common file languages to grammars', () => {
    expect(scopeForLanguage('typescript')).toBe('source.ts')
    expect(scopeForLanguage('rust')).toBe('source.rust')
  })

  it('returns syntax markup for a TypeScript source', async () => {
    const html = await highlightCodeBuiltin('typescript', 'const answer: number = 42')
    expect(html).toContain('const')
    expect(html).toMatch(/class="pl-[^"]+"/)
  })
})

// 以下行为锁迁移自 scripts/test-code-highlight.mts（P91 A2 下沉）：
// 原脚本是源码 token 断言（Node 加载不了 onig.wasm 时代的替代品），vitest 能真跑高亮后改为行为验证。
describe('scopeForLanguage 映射表', () => {
  it('常见语言别名映射到 grammar scope', () => {
    expect(scopeForLanguage('ts')).toBe('source.ts')
    expect(scopeForLanguage('python')).toBe('source.python')
    expect(scopeForLanguage('sh')).toBe('source.shell')
    expect(scopeForLanguage('jsx')).toBe('source.js')
    expect(scopeForLanguage('html')).toBe('text.html.basic')
  })

  it('未知语言不在映射表中', () => {
    expect(scopeForLanguage('unknown')).toBeUndefined()
  })
})

describe('highlightCode 未知语言', () => {
  it('scope 或 loader 缺失时返回 null', async () => {
    await expect(highlightCode('unknown-language', 'const x = 1')).resolves.toBeNull()
  })
})

describe('grammar loaders 全量真实加载', () => {
  // 原 STRUCTURE GUARD 锁「GRAMMAR_LOADERS 覆盖 14 个 scope」；行为等价锁 =
  // 每个语言真实走完高亮管线（缺 loader/语法包时这里会红），能分词的语言再锁 pl-* 标记。
  // 已知限制（P91 登记）：source.c++ 语法包顶层 include 依赖 source.c 同场注册，
  // 单 scope 注册时静默零分词（返回纯转义文本，不报错）——生产同构，cpp 暂只锁非 null。
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
    expect(html!).toMatch(/class="pl-[^"]+"/)
  })

  it('cpp 管线不崩且不返回 null（loader 在场）', async () => {
    await expect(highlightCode('cpp', 'int main() { return 0; }')).resolves.not.toBeNull()
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
