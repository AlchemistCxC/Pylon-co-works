import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * #129 子项 2/4/5 + 子项 1 的护栏：字体系统真值源契约。
 *
 * 此前字体栈在 index.css 与 builtinPylonRenderers.ts 各存一份字符串真值，
 * serif 侧已实际漂移（TS 侧缺 'SimSun'，Windows 上设置预览与真实渲染落到
 * 不同的 CJK 衬线字形）。收敛后 index.css 是唯一真值，内置贡献 family 引用
 * 同一 token；--type-content-font 角色跟随实际正文渲染链；按模式 fallback
 * 死分支删除。本用例只读源码文本，不依赖浏览器。
 */

const indexCss = readFileSync('src/index.css', 'utf8')
const renderers = readFileSync('src/plugins/product/builtinPylonRenderers.ts', 'utf8')

describe('字体栈真值源契约（#129 子项 2）', () => {
  it('index.css 声明三条默认字体栈（唯一真值源）', () => {
    expect(indexCss).toMatch(/--font-system\s*:/)
    expect(indexCss).toMatch(/--font-serif-default\s*:/)
    expect(indexCss).toMatch(/--font-mono-default\s*:/)
  })

  it('serif 默认栈保留 CJK 衬线回退 SimSun（Windows 唯一系统衬线）', () => {
    const declaration = indexCss.match(/--font-serif-default\s*:[^;]+;/)?.[0] ?? ''
    expect(declaration).toContain("'SimSun'")
  })

  it('三个内置字体贡献的 family 引用 index.css 的默认 token，不再自存栈字符串', () => {
    expect(renderers).toContain("family: 'var(--font-system)'")
    expect(renderers).toContain("family: 'var(--font-serif-default)'")
    expect(renderers).toContain("family: 'var(--font-mono-default)'")
    // 旧的内联栈字符串不得回流（一旦回流，预览与真实渲染再度分叉）
    expect(renderers).not.toMatch(/family:\s*['"]-apple-system/)
    expect(renderers).not.toContain("'Iowan Old Style'")
    expect(renderers).not.toContain("'Sarasa Mono SC'")
  })
})

describe('内容字体角色与正文同源（#129 子项 4）', () => {
  it('--type-content-font 基线取 msg-font 优先链（与 ChatView/InputBar 的 de-facto 正文链一致）', () => {
    expect(indexCss).toMatch(
      /--type-content-font\s*:\s*var\(--msg-font,\s*var\(--chat-font,\s*var\(--font-mono-default\)\)\)/,
    )
  })

  it('按模式 fallback 死分支已删除（--chat-font 恒被内联，fallback 永不求值）', () => {
    expect(indexCss).not.toMatch(
      /\[data-interface-mode="terminal-like"\]\s*\{[^}]*--type-content-font/,
    )
    expect(indexCss).not.toMatch(
      /\[data-interface-mode="modern-gui"\]\s*\{[^}]*--type-content-font/,
    )
  })
})

describe('表单控件字体继承（#129 子项 1）', () => {
  it('base 层为 button/input/select/textarea 提供 font:inherit（零特异性，组件规则可覆盖）', () => {
    const start = indexCss.indexOf('@layer base')
    expect(start).toBeGreaterThanOrEqual(0)
    const open = indexCss.indexOf('{', start)
    let depth = 0
    let close = -1
    for (let i = open; i < indexCss.length; i += 1) {
      if (indexCss[i] === '{') depth += 1
      else if (indexCss[i] === '}') {
        depth -= 1
        if (depth === 0) { close = i; break }
      }
    }
    const baseBlock = indexCss.slice(open, close)
    expect(baseBlock).toContain(':where(button, input, select, textarea)')
    expect(baseBlock).toContain('font: inherit')
  })
})
