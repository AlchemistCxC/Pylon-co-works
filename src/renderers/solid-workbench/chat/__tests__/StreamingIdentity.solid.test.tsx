// @vitest-environment jsdom
import { createSignal } from 'solid-js'
import { render, waitFor } from '@solidjs/testing-library'
import { describe, expect, it } from 'vitest'
import { MarkdownContent } from '../MarkdownContent.solid.tsx'

/**
 * C00 验收：1000 chunk 流式追加不 remount。
 *
 * 契约：stable 前缀不变时，其 DOM 节点身份保持不变（不重解析、不重建）；
 * 只有 unstable 尾块随内容增长更新。锚定 stable 区的 h1 元素验证身份。
 *
 * 注意：waitFor 回调返回 null 会直接 resolve(null)（不轮询），
 * 必须以 throw 表达"未就绪"。
 */
describe('C00 streaming root identity (1000 chunks)', () => {
  it('keeps stable heading identity across 1000 tail appends', async () => {
    // 初始即含一个已完成块边界；此后 1000 chunk 全部落在 unstable 尾块内
    const [text, setText] = createSignal('# 稳定标题\n\n尾块起点。')
    const result = render(() => <MarkdownContent text={text()} streaming />)

    const headingBefore = await waitFor(() => {
      const found = result.container.querySelector('h1')
      if (!found) throw new Error('h1 not mounted yet')
      return found
    }, { timeout: 5000 })
    expect(headingBefore.textContent).toBe('稳定标题')

    for (let i = 0; i < 1000; i += 1) {
      setText(current => `${current}chunk-${i} `)
    }

    await waitFor(() => {
      if (!result.container.textContent?.includes('chunk-999')) throw new Error('tail not flushed')
    }, { timeout: 5000 })
    const headingAfter = result.container.querySelector('h1')!
    // stable 段 DOM 身份不变——1000 chunk 零 remount
    expect(headingAfter).toBe(headingBefore)
  })

  it('keeps plain-text streaming paragraph identity when no markdown structure appears', async () => {
    const [text, setText] = createSignal('纯文本流')
    const result = render(() => <MarkdownContent text={text()} streaming />)
    const paragraphBefore = await waitFor(() => {
      const found = result.container.querySelector('.term-plain-text')
      if (!found) throw new Error('paragraph not mounted yet')
      return found
    }, { timeout: 5000 })
    for (let i = 0; i < 1000; i += 1) {
      setText(current => `${current} 第${i}句`)
    }
    await waitFor(() => {
      if (!result.container.textContent?.includes('第999句')) throw new Error('tail not flushed')
    }, { timeout: 5000 })
    const paragraphAfter = result.container.querySelector('.term-plain-text')!
    expect(paragraphAfter).toBe(paragraphBefore)
  })
})


