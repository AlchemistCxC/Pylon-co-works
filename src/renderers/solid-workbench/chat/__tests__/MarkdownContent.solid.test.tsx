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
import { createSignal } from 'solid-js'
import { afterEach, describe, expect, it } from 'vitest'
import { MarkdownContent } from '../MarkdownContent.solid.tsx'

afterEach(() => {
  cleanup()
})

describe('MarkdownContent heading class contract（CSS-02，CSS-04 回归门）', () => {
  it('`# h1` 输出 h1.term-h1；`###### h6` 输出 h6.term-h6', async () => {
    render(() => <MarkdownContent text="# Title&#10;&#10;###### Small" />)
    const h1 = await waitFor(() => screen.getByRole('heading', { level: 1 }), { timeout: 10_000 })
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

  it('Bug4：streaming 增量渲染——切分后内容完整、结构正确（标题+段落+代码围栏）', async () => {
    // 流式文本含已完成块 + 增长尾部；增量切分后必须仍完整渲染出所有内容，结构不被劈坏。
    render(() => (
      <MarkdownContent
        text={'# 标题\n\n第一段已完成\n\n```js\nconst x = 1\n```\n\n正在增长的新段落'}
        streaming
      />
    ))
    const h1 = await waitFor(() => screen.getByRole('heading', { level: 1 }))
    expect(h1).toBeTruthy()
    expect(screen.getByText('第一段已完成')).toBeTruthy()
    // 代码块内容与增长尾部都应出现
    expect(screen.getByText(/const x = 1/)).toBeTruthy()
    expect(screen.getByText('正在增长的新段落')).toBeTruthy()
  })

  it('streaming 不在带缩进的未闭合代码围栏内部拆块', async () => {
    const { container } = render(() => <MarkdownContent
      text={'前置段落\n\n   ```js\nconst first = 1\n\nconst second = 2'}
      streaming
    />)

    await waitFor(() => expect(container.textContent).toContain('const second = 2'))
    const codeBlock = container.querySelector('.term-code-block')
    expect(codeBlock).not.toBeNull()
    expect(codeBlock).toHaveTextContent('const first = 1')
    expect(codeBlock).toHaveTextContent('const second = 2')
    expect(container.querySelectorAll('.term-code-block')).toHaveLength(1)
  })

  it('流式结束后仍保留 Markdown 诗歌的段落与软换行', async () => {
    const [state, setState] = createSignal({
      text: '**星河**\n\n春风拂过山岗\n月光落在窗\n\n我把远方写进诗行\n让星河在梦里流淌',
      streaming: true,
    })
    const result = render(() => <MarkdownContent text={state().text} streaming={state().streaming} />)

    await waitFor(() => expect(result.container).toHaveTextContent('让星河在梦里流淌'))
    setState(current => ({ ...current, streaming: false }))

    await waitFor(() => {
      const paragraphs = [...result.container.querySelectorAll('p')]
      if (paragraphs.length < 2) throw new Error('final Markdown paragraphs not mounted')
      expect(paragraphs.every(paragraph => paragraph.classList.contains('term-p'))).toBe(true)
      expect(paragraphs.some(paragraph => paragraph.textContent?.includes('春风拂过山岗\n月光落在窗'))).toBe(true)
    })
  })

  it('单行 fenced code 仍渲染为块级代码而不是 inline code', async () => {
    const { container } = render(() => <MarkdownContent text={'```ts\nconst x = 1\n```'} />)
    await waitFor(() => expect(container.querySelector('.term-code-block')).not.toBeNull())
    expect(container.querySelector('.term-code-block')).toHaveTextContent('const x = 1')
    expect(container.querySelector(':scope > .term-inline-code')).toBeNull()
  })

  it('保留安全 Markdown 图片并拒绝可执行 source', async () => {
    const safe = render(() => <MarkdownContent text="![diagram](https://example.com/diagram.png)" />)
    await waitFor(() => expect(safe.container.querySelector('img')).not.toBeNull())
    expect(safe.container.querySelector('img')).toHaveAttribute('src', 'https://example.com/diagram.png')
    safe.unmount()

    const unsafe = render(() => <MarkdownContent text="![bad](javascript:alert(1))" />)
    await waitFor(() => expect(unsafe.container).toHaveTextContent('bad'))
    expect(unsafe.container.querySelector('img')).toBeNull()
  })

  it('保留无 scheme 的工作区相对文件链接，供 AgentSheet 捕获并转入 FileSheet', async () => {
    const { container } = render(() => <MarkdownContent text="[main](src/main.ts#L12)" />)
    await waitFor(() => expect(container.querySelector('a')).not.toBeNull())
    expect(container.querySelector('a')).toHaveAttribute('href', 'src/main.ts#L12')
  })
})
