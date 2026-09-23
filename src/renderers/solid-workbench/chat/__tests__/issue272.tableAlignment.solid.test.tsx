// @vitest-environment jsdom

/**
 * #272：GFM 表格列对齐渲染回归门。
 * 依赖真实 markdown 解析链（wasm parseMarkdown，align 属性与 parity 快照同形状），
 * 断言解析层的 align 属性在 DOM 中存活——渲染层透传被移除即红。
 */

import { cleanup, render, waitFor } from '@solidjs/testing-library'
import { afterEach, describe, expect, it } from 'vitest'
import { MarkdownContent } from '../MarkdownContent.solid.tsx'
import { clearMarkdownRenderModelCache } from '../markdownRenderModel.ts'

afterEach(() => {
  cleanup()
  clearMarkdownRenderModelCache()
})

describe('#272 表格列对齐', () => {
  it('GFM 分隔符落到 th 的 align 属性（:---: 居中、---: 右、缺省无属性=左）', async () => {
    render(() => <MarkdownContent text={'| 左 | 中 | 右 |\n| --- | :---: | ---: |\n| a | b | c |'} />)
    await waitFor(
      () => expect(document.querySelectorAll('.term-table td').length).toBe(3),
      { timeout: 10_000 },
    )
    const heads = [...document.querySelectorAll('.term-table th')]
    expect(heads.map(head => head.getAttribute('align'))).toEqual([null, 'center', 'right'])
    const cells = [...document.querySelectorAll('.term-table td')]
    expect(cells.map(cell => cell.getAttribute('align'))).toEqual([null, 'center', 'right'])
  })
})
