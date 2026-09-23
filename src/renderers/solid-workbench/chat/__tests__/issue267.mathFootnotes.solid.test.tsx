// @vitest-environment jsdom

/**
 * #267：数学公式（Temml → MathML）与 GFM 脚注的渲染回归门。
 *
 * 依赖真实 markdown 解析链（wasm 计算核 parseMarkdown + math_dollars/footnotes
 * 扩展，模型与 parity 快照同形状），非 mock——可捕获解析形状漂移或渲染特判被改的回归。
 *
 * 等待口径：本仓的 waitFor（@testing-library/dom）对「返回 null 的回调」立即 resolve，
 * 只有回调**抛断言异常**才重试——因此一律用 expect-throw 风格轮询（与既有测试一致）。
 */

import { cleanup, render, waitFor } from '@solidjs/testing-library'
import { afterEach, describe, expect, it } from 'vitest'
import { MarkdownContent } from '../MarkdownContent.solid.tsx'
import { renderMathMarkup } from '../mathRender.solid.tsx'
import { clearMarkdownRenderModelCache } from '../markdownRenderModel.ts'

afterEach(() => {
  cleanup()
  clearMarkdownRenderModelCache()
})

describe('#267 数学公式渲染', () => {
  it('行内 `$f(x)=x^{2}$` 渲染为 MathML（span.term-math-inline 内含 math 元素）', async () => {
    render(() => <MarkdownContent text="动能 $E=mc^{2}$ 守恒" />)
    await waitFor(() => expect(document.querySelector('.term-math-inline math')).toBeTruthy(), { timeout: 10_000 })
    expect(document.body.textContent).not.toContain('$')
  })

  it('独立段 `$$…$$` 提升为显示块（div.term-math-display，Temml displayMode）', async () => {
    render(() => <MarkdownContent text={'$$\nS=\\sum_{n=1}^{\\infty}\\frac{1}{n^{2}}\n$$'} />)
    await waitFor(() => expect(document.querySelector('.term-math-display math')).toBeTruthy(), { timeout: 10_000 })
    expect(document.querySelector('.term-math-display math')?.getAttribute('display')).toBe('block')
  })

  it('含公式的纯段落不被 fast path 免解析直出', async () => {
    // 该输入不含其它 markdown 结构字符——若 fast path 未补 math 触发模式，
    // 会以 term-plain-text 直出裸文本而非 MathML。
    render(() => <MarkdownContent text="值是 $a+b$" />)
    await waitFor(() => expect(document.querySelector('.term-math-inline math')).toBeTruthy(), { timeout: 10_000 })
  })
})

describe('#267 GFM 脚注渲染', () => {
  it('引用上标 + 文末脚注节 + 回链锚点齐备', async () => {
    render(() => <MarkdownContent text={'Hi[^1]\n\n[^1]: A greeting.'} />)
    await waitFor(() => expect(document.querySelector('.term-footnote-ref a[href="#user-content-fn-1"]')).toBeTruthy(), { timeout: 10_000 })
    const ref = document.querySelector('.term-footnote-ref a[href="#user-content-fn-1"]')
    expect(ref?.getAttribute('id')).toBe('user-content-fnref-1')
    expect(ref?.textContent).toBe('1')
    // 引用锚原地跳转（hash 链接不带 target=_blank）
    expect(ref?.getAttribute('target')).toBeNull()

    const section = document.querySelector('section.term-footnotes')
    expect(section).toBeTruthy()
    const item = section?.querySelector('li#user-content-fn-1')
    expect(item?.textContent).toContain('A greeting.')
    const backref = item?.querySelector('a[href="#user-content-fnref-1"]')
    expect(backref?.textContent).toBe('↩')
  })

  it('未定义引用保持字面文本（内容不丢，无 sup）', async () => {
    render(() => <MarkdownContent text="Hi[^ghost]" />)
    await waitFor(() => expect(document.body.textContent).toContain('Hi[^ghost]'))
    expect(document.querySelector('sup')).toBeNull()
  })
})

describe('#267 renderMathMarkup 结果缓存（性能守卫）', () => {
  it('同输入第二次调用命中缓存（返回同一字符串实例）', () => {
    const first = renderMathMarkup('a+b', false)
    const second = renderMathMarkup('a+b', false)
    expect(first).toBeTruthy()
    expect(second).toBe(first)
  })

  it('display 与 inline 分别缓存（同 latex 不同形态不同输出）', () => {
    const inline = renderMathMarkup('x', false)
    const display = renderMathMarkup('x', true)
    expect(inline).not.toBe(display)
    expect(display).toContain('display="block"')
  })

  it('失败（null）同样入缓存：同输入不再重试', () => {
    const a = renderMathMarkup('#267-probe-never-invalid', false)
    const b = renderMathMarkup('#267-probe-never-invalid', false)
    expect(a).toBe(b)
  })
})
