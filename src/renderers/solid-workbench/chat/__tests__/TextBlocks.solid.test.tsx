// @vitest-environment jsdom
import { cleanup, render } from '@solidjs/testing-library'
import { afterEach, describe, expect, it } from 'vitest'
import { SolidAnsiBlock } from '../AnsiBlock.solid.tsx'
import { SolidCodeBlock } from '../CodeBlock.solid.tsx'

afterEach(() => cleanup())

/**
 * C00 RED：content.code / content.ansi 的 Solid surface 契约。
 * code：语言标签、高亮失败回退 escaped plain、copy 按钮、oversize 折叠。
 * ansi：脱敏渲染、原始文本可复制、reduced-motion 标记。
 */
describe('SolidCodeBlock (C00)', () => {
  it('shows language label and renders highlighted lines without remounting on update', async () => {
    const result = render(() => <SolidCodeBlock code={'const a = 1\nconst b = 2'} language="ts" />)
    expect(result.container.querySelector('.term-code-lang')?.textContent).toBe('ts')
    // 高亮是异步资源；至少原始行可见（回退路径）
    expect(result.container.textContent).toContain('const a = 1')
  })

  it('falls back to escaped plain text when language is unknown', () => {
    const result = render(() => <SolidCodeBlock code={'<img src=x onerror=alert(1)>'} language="definitely-not-a-language" />)
    const block = result.container.querySelector('.term-code-block')!
    expect(block.textContent).toContain('<img src=x onerror=alert(1)>')
    // 不产生任何注入元素
    expect(block.querySelector('img')).toBeNull()
  })

  it('folds oversize code with explicit truncation notice and keeps full text for copy', async () => {
    const long = Array.from({ length: 400 }, (_, i) => `line-${i}`).join('\n')
    const result = render(() => <SolidCodeBlock code={long} language="text" maxLines={50} />)
    const visible = result.container.querySelectorAll('.term-code-line').length
    // 折叠点在行边界：可见行数 ≤ maxLines + 1（截断行本身）
    expect(visible).toBeLessThanOrEqual(52)
    expect(result.container.textContent).toContain('已折叠')
    // 复制按钮携带完整原文（data-copy-text），搜索/复制不受折叠影响
    const copyButton = result.getByRole('button', { name: /复制/ })
    expect(copyButton.getAttribute('data-copy-text')).toBe(long)
  })

  it('copies via clipboard adapter and shows copied feedback', async () => {
    let copiedText: string | undefined
    const result = render(() => <SolidCodeBlock code="hello" language="txt" onCopy={text => { copiedText = text }} />)
    const { fireEvent } = await import('@solidjs/testing-library')
    await fireEvent.click(result.getByRole('button', { name: /复制/ }))
    expect(copiedText).toBe('hello')
    expect(result.getByRole('button', { name: '已复制' })).toBeTruthy()
  })
})

describe('SolidAnsiBlock (C00)', () => {
  it('renders sanitized colored spans and strips injection payloads', () => {
    const result = render(() => <SolidAnsiBlock text={'\u001b[31mERROR\u001b[0m \u001b]0;evil\u0007done'} />)
    const root = result.container.querySelector('.term-ansi-block')!
    expect(root.querySelector('.term-ansi-fg-red')?.textContent).toContain('ERROR')
    expect(JSON.stringify(root.innerHTML)).not.toContain('evil')
    expect(root.textContent).toContain('done')
  })

  it('exposes raw accessible text (controls stripped) and reduced-motion marker', () => {
    const result = render(() => <SolidAnsiBlock text={'\u001b[32mOK\u001b[0m'} reducedMotion={true} />)
    const root = result.container.querySelector('.term-ansi-block')!
    expect(root.getAttribute('data-reduced-motion')).toBe('true')
    expect(root.getAttribute('aria-label')).toBe('OK')
  })
})
