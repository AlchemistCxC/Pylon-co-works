// @vitest-environment jsdom
import { cleanup, render } from '@solidjs/testing-library'
import { createSignal } from 'solid-js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * P57 S3-R8 + A11（R-B8/A11）验收 3：
 * - MarkdownSegment pending 且有上一模型时渲染 model.latest，DOM 不泄漏原始 `**`/反引号；
 * - 仅首次解析（从未 resolve）渲染 .term-md-skeleton[aria-busy]；
 * - 流式增长尾块的解析以 { cache: false } 绕过 LRU，非流式解析默认仍走缓存（签名向后兼容）。
 *
 * 解析器用可控 deferred mock（真实解析的 pending 窗口不可确定）。
 */
const harness = vi.hoisted(() => ({
  calls: [] as Array<{ text: string; options: { readonly cache?: boolean } | undefined }>,
  resolvers: [] as Array<(root: unknown) => void>,
}))

vi.mock('../markdownRenderModel.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../markdownRenderModel.ts')>()
  return {
    ...actual,
    getMarkdownRenderModel(markdown: string, options?: { readonly cache?: boolean }) {
      harness.calls.push({ text: markdown, options })
      return new Promise(resolve => {
        harness.resolvers.push(parsedRoot => resolve(parsedRoot))
      })
    },
  }
})

import { MarkdownContent } from '../MarkdownContent.solid.tsx'

function parsedRoot(marker: string): unknown {
  return {
    type: 'root',
    children: [{
      type: 'element',
      tagName: 'p',
      properties: {},
      children: [{ type: 'text', value: `PARSED:${marker}` }],
    }],
  }
}

/** flush 微任务队列（Solid effect / resource 解析链）。 */
async function flushMicrotasks(): Promise<void> {
  for (let round = 0; round < 4; round += 1) await Promise.resolve()
}

/** resolve 第 pendingIndex 个请求为一段确定性的已解析内容（不含原始 markdown 标记）。 */
async function resolvePending(index: number, marker: string): Promise<void> {
  const resolve = harness.resolvers[index]
  if (!resolve) throw new Error(`no pending parse at ${index}`)
  resolve(parsedRoot(marker))
  await flushMicrotasks()
}

beforeEach(() => {
  harness.calls.length = 0
  harness.resolvers.length = 0
})

afterEach(() => {
  cleanup()
})

describe('MarkdownSegment pending model contract（P57 S3-R8+A11）', () => {
  it('首次解析（从未 resolve）渲染解析骨架，不渲染原始 markdown 标记', async () => {
    const { container } = render(() => <MarkdownContent text="**尚未解析**" streaming />)
    await flushMicrotasks()
    const skeleton = container.querySelector('.term-md-skeleton')
    expect(skeleton).not.toBeNull()
    expect(skeleton).toHaveAttribute('aria-busy', 'true')
    expect(container.textContent).not.toContain('**')

    await resolvePending(0, 'first')
    expect(container.querySelector('.term-md-skeleton')).toBeNull()
    expect(container.textContent).toContain('PARSED:first')
  })

  it('pending 期渲染 model.latest（上一模型），DOM 不泄漏原始 **/反引号标记', async () => {
    const [text, setText] = createSignal('**first**')
    const { container } = render(() => <MarkdownContent text={text()} streaming />)
    await flushMicrotasks()
    await resolvePending(0, 'first')
    expect(container.textContent).toContain('PARSED:first')

    // 新文本触发重解析；resolve 之前处于 pending
    setText('**first** 加长 `code`')
    await flushMicrotasks()
    expect(harness.resolvers.length).toBe(2)
    // model.latest 兜底：不回落原始文本，不泄漏 **/`
    expect(container.textContent).toContain('PARSED:first')
    expect(container.textContent).not.toContain('**')
    expect(container.textContent).not.toContain('`')

    await resolvePending(1, 'second')
    expect(container.textContent).toContain('PARSED:second')
  })

  it('流式增长尾块解析绕缓存（cache:false），非流式解析默认仍走缓存', async () => {
    const { container } = render(() => <MarkdownContent text="**尾块**" streaming />)
    await flushMicrotasks()
    const tailCall = harness.calls.find(call => call.text === '**尾块**')
    expect(tailCall).toBeDefined()
    expect(tailCall!.options).toMatchObject({ cache: false })
    await resolvePending(0, 'tail')
    expect(container.textContent).not.toContain('**')

    // 非 streaming 路径（已提交消息）默认仍走缓存（签名向后兼容：cache 不为 false）
    const committed = render(() => <MarkdownContent text="**已提交**" />)
    await flushMicrotasks()
    const committedCall = harness.calls.find(call => call.text === '**已提交**')
    expect(committedCall).toBeDefined()
    expect(committedCall!.options?.cache).not.toBe(false)
    await resolvePending(1, 'committed')
    expect(committed.container.textContent).toContain('PARSED:committed')
  })
})
