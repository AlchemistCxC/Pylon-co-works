// @vitest-environment jsdom

/**
 * CSS-04：Solid renderer 真实 DOM 渲染回归测试（CR-325 消化——css01 headingDomContract 与
 * 工具同源无法捕获 renderer 回归，此测试直接渲染 MarkdownContent 验证 heading class 输出）。
 *
 * 覆盖：`# h1` → h1.term-h1；`###### h6` → h6.term-h6；普通段落不携带 term-h 类。
 * 依赖真实 markdown 解析链（getMarkdownRenderModel：unified + remarkParse/Gfm/Rehype），
 * 非 mock——可捕获 allowedTagName 或 headingClass 派生逻辑被改的回归。
 */

import { cleanup, render, screen, waitFor } from '@solidjs/testing-library'
import { afterEach, describe, expect, it } from 'vitest'
import { MarkdownContent } from '../MarkdownContent.solid.tsx'

afterEach(() => {
  cleanup()
})

describe('MarkdownContent heading class contract（CSS-02，CSS-04 回归门）', () => {
  it('`# h1` 输出 h1.term-h1；`###### h6` 输出 h6.term-h6', async () => {
    render(() => <MarkdownContent text="# Title&#10;&#10;###### Small" />)
    const h1 = await waitFor(() => screen.getByRole('heading', { level: 1 }))
    expect(h1.tagName).toBe('H1')
    expect(h1.getAttribute('class')).toContain('term-h1')
    const h6 = await waitFor(() => screen.getByRole('heading', { level: 6 }))
    expect(h6.tagName).toBe('H6')
    expect(h6.getAttribute('class')).toContain('term-h6')
  })

  it('普通段落不携带 term-h 类（headingClass 仅派生自 h1-h6）', async () => {
    render(() => <MarkdownContent text="plain text only" />)
    expect(screen.queryByRole('heading')).toBeNull()
    const paragraph = await waitFor(() => screen.getByText('plain text only'))
    expect(paragraph.className).toContain('term-p')
    expect(paragraph.className).not.toContain('term-h')
  })
})
