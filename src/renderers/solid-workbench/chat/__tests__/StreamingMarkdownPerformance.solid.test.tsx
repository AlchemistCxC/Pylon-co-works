// @vitest-environment jsdom
import { cleanup, render, waitFor } from '@solidjs/testing-library'
import { createSignal } from 'solid-js'
import { afterEach, describe, expect, it, vi } from 'vitest'

const counters = vi.hoisted(() => ({ parse: vi.fn(), highlight: vi.fn() }))

vi.mock('../markdownRenderModel.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../markdownRenderModel.ts')>()
  return {
    ...actual,
    getMarkdownRenderModel(markdown: string) {
      counters.parse(markdown)
      return actual.getMarkdownRenderModel(markdown)
    },
  }
})

vi.mock('../../../../components/chat/codeHighlight.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../../components/chat/codeHighlight.ts')>()
  return {
    ...actual,
    highlightCode(language: string, code: string) {
      counters.highlight(language, code)
      return Promise.resolve(null)
    },
  }
})

import { MarkdownContent } from '../MarkdownContent.solid.tsx'

afterEach(() => {
  cleanup()
  counters.parse.mockClear()
  counters.highlight.mockClear()
})

describe('canonical streaming Markdown performance contract', () => {
  it('does not parse or highlight an open fenced-code tail for every chunk', async () => {
    const [text, setText] = createSignal('# 稳定标题\n\n```ts\nconst first = 1')
    const result = render(() => <MarkdownContent text={text()} streaming />)

    const heading = await waitFor(
      () => result.getByRole('heading', { level: 1 }),
      { timeout: 10_000 },
    )
    await waitFor(() => expect(result.container).toHaveTextContent('const first = 1'))
    const parseCount = counters.parse.mock.calls.length
    expect(counters.highlight).not.toHaveBeenCalled()

    for (let index = 0; index < 100; index += 1) {
      setText(current => `${current}\nconst value${index} = ${index}`)
    }

    await waitFor(() => expect(result.container).toHaveTextContent('const value99 = 99'))
    expect(counters.parse).toHaveBeenCalledTimes(parseCount)
    expect(counters.highlight).not.toHaveBeenCalled()
    expect(result.getByRole('heading', { level: 1 })).toBe(heading)
  })

  it('highlights once after the fence closes, then keeps that code DOM while the tail grows', async () => {
    const [text, setText] = createSignal('# 稳定标题\n\n```ts\nconst value = 1')
    const result = render(() => <MarkdownContent text={text()} streaming />)
    await waitFor(() => expect(result.container).toHaveTextContent('const value = 1'))

    setText('# 稳定标题\n\n```ts\nconst value = 1\nconst second = 2\n```\n\n尾部')
    const code = await waitFor(() => {
      const found = result.container.querySelector('.term-code-block')
      if (!found) throw new Error('closed code block not mounted')
      return found
    })
    await waitFor(() => expect(counters.highlight).toHaveBeenCalledTimes(1))

    for (let index = 0; index < 100; index += 1) setText(current => `${current} ${index}`)
    await waitFor(() => expect(result.container).toHaveTextContent('99'))
    expect(counters.highlight).toHaveBeenCalledTimes(1)
    expect(result.container.querySelector('.term-code-block')).toBe(code)
  })

  it('runs the final parse and highlight once when an open fence stream completes', async () => {
    const [streaming, setStreaming] = createSignal(true)
    const text = '```ts\nconst first = 1\nconst second = 2'
    const result = render(() => <MarkdownContent text={text} streaming={streaming()} />)

    await waitFor(() => expect(result.container.querySelector('[data-streaming-code="true"]')).not.toBeNull())
    expect(counters.highlight).not.toHaveBeenCalled()
    const parseCount = counters.parse.mock.calls.length

    setStreaming(false)

    await waitFor(() => expect(result.container.querySelector('[data-streaming-code="true"]')).toBeNull())
    await waitFor(() => expect(counters.highlight).toHaveBeenCalledTimes(1))
    expect(counters.parse).toHaveBeenCalledTimes(parseCount + 1)
  })
})
