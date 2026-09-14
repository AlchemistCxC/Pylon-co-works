// @vitest-environment jsdom
import { cleanup, render, waitFor } from '@solidjs/testing-library'
import { createSignal } from 'solid-js'
import { afterEach, describe, expect, it } from 'vitest'
import { MarkdownContent } from '../MarkdownContent.solid.tsx'

afterEach(cleanup)

/**
 * 行元素文本：容器直接子元素 = 行渲染出的顶层块。
 * 注意一个「行」在解析路径下可能产出多个顶层元素（例如标题紧跟段落），所以这里读的是元素文本。
 */
function blockTexts(container: HTMLElement): string[] {
  return [...container.children].map(element => element.textContent ?? '')
}

function hasStructuralEdgeWhitespace(text: string): boolean {
  return /^\s/.test(text) || /\s$/.test(text)
}

describe('issue 55: 行文本不变式', () => {
  it('尾块的前导分隔空行不进入行文本（历史 \\n\\n快 残留）', async () => {
    // 发布 1 先把首个块提交掉（committedText 停在该块末尾）。
    const [text, setText] = createSignal('A\n\n')
    const { container } = render(() => <MarkdownContent text={text()} streaming />)
    await waitFor(() => expect(container.textContent).toContain('A'))

    // 发布 2 的 pending 正好以空行开头：旧实现只在「本轮命中稳定块」时才裁前导分隔，
    // 于是把 '\n\n快' 整段当成行文本，渲染成先空一行再输出几个字（真机快照里的 '\n\n快'）。
    setText('A\n\n\n\n快')
    await waitFor(() => expect(container.textContent).toContain('快'))

    const blocks = blockTexts(container)
    expect(blocks.length).toBeGreaterThan(0)
    expect(blocks.every(block => block.length > 0)).toBe(true)
    expect(blocks.some(block => block.startsWith('\n'))).toBe(false)
    expect(blocks.every(block => !hasStructuralEdgeWhitespace(block))).toBe(true)
    expect(blocks.join('|')).toContain('快')
  })

  it('纯结构空白的尾块不渲染为空行', async () => {
    const [text, setText] = createSignal('A')
    const { container } = render(() => <MarkdownContent text={text()} streaming />)
    await waitFor(() => expect(container.textContent).toContain('A'))

    setText('A\n\n ')
    await waitFor(() => expect(container.textContent).toContain('A'))

    const blocks = blockTexts(container)
    expect(blocks.every(block => block.length > 0)).toBe(true)
  })
})
