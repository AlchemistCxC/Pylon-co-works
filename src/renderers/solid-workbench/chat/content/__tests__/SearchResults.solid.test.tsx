// @vitest-environment jsdom
import { render } from '@solidjs/testing-library'
import { describe, expect, it, vi } from 'vitest'
import { SolidSearchOrLink } from '../SearchResults.solid.tsx'
import type { ContentPart } from '../../../../../domains/workbench/content/contentPartSchema.ts'

/**
 * C05 RED：搜索结果/链接卡契约。
 *
 * - 高亮是纯文本 range 切分（<mark>），snippet 尖括号原样显示（零 HTML 注入）；
 * - collapsed 只是 hint：可展开全部条目，无删除；
 * - oversize 显示已显示/总数 + 加载更多；分页 token 提示剩余需分页；
 * - open/copy capability-gated，危险 scheme disabled + 原因。
 */

function block(part: ContentPart, actions?: Parameters<typeof SolidSearchOrLink>[0]['actions']) {
  return render(() => <SolidSearchOrLink part={part} actions={actions} />)
}

const samplePart = {
  kind: 'search-result',
  query: 'render lifecycle',
  total: 42,
  pagingToken: 'page-2',
  results: [
    { source: '/src/app.tsx', rank: 1, location: { line: 12 }, snippet: 'the render lifecycle starts here', highlights: [{ start: 4, end: 10 }], score: 0.93 },
    { source: 'https://docs.example.com/lifecycle', title: 'Lifecycle docs', snippet: 'lifecycle overview', rank: 2 },
    { source: '/src/b.ts', rank: 3, snippet: 'third' },
    { source: '/src/c.ts', rank: 4, snippet: 'fourth' },
    { source: '/src/d.ts', rank: 5, snippet: 'fifth' },
  ],
} as unknown as ContentPart

describe('C05 SolidSearchResultsBlock', () => {
  it('renders entries with rank/source/line/score', () => {
    const result = block(samplePart)
    expect(result.container.textContent).toContain('/src/app.tsx')
    expect(result.container.textContent).toContain('L12')
    expect(result.container.textContent).toContain('score 0.93')
    expect(result.container.textContent).toContain('Lifecycle docs')
  })

  it('marks highlight ranges via <mark> split — never injects HTML into snippet', () => {
    const htmlInjection = {
      kind: 'search-result',
      results: [{ source: 'a.md', snippet: '<b>bold</b> claim', highlights: [{ start: 0, end: 3 }] }],
    } as unknown as ContentPart
    const result = block(htmlInjection)
    // <mark> 只包住 range 文本；snippet 原文以纯文本节点出现
    const mark = result.container.querySelector('mark.term-search-mark')
    expect(mark?.textContent).toBe('<b>')
    // 不存在由 snippet 内容生成的元素
    expect(result.container.querySelector('b')).toBeNull()
  })

  it('collapsed by default with expand-all hint; expand shows original entries without loss', async () => {
    const result = block(samplePart)
    // 默认只显示前 3 条 + 展开提示
    const before = result.container.querySelectorAll('.term-search-item').length
    expect(before).toBe(3)
    const expand = [...result.container.querySelectorAll('button')].find(b => b.textContent?.includes('展开全部'))
    await expand!.click()
    await Promise.resolve()
    const after = result.container.querySelectorAll('.term-search-item').length
    expect(after).toBe(5)
    // 分组不损失原条目：rank 1–5 全部可见
    for (let rank = 1; rank <= 5; rank += 1) {
      expect(result.container.textContent).toContain(String(rank))
    }
  })

  it('shows displayed/total and load-more; paging token notes remainder', async () => {
    // 12 条触发分页（默认每页 10）
    const twelve = Array.from({ length: 12 }, (_, i) => ({ source: `/f/${i}.ts`, rank: i + 1, snippet: `s${i}` }))
    const result = block({ ...samplePart, results: twelve } as unknown as ContentPart)
    expect(result.container.textContent).toContain('42 条')
    const loadMore = [...result.container.querySelectorAll('button')].find(b => b.textContent?.includes('加载更多'))
    expect(loadMore?.textContent).toContain('已显示 10/12')
    await loadMore!.click()
    await Promise.resolve()
    // 全部展开后，剩余由 pagingToken 说明
    expect(result.container.textContent).toContain('其余')
  })

  it('empty search result renders no list items', () => {
    const empty = { kind: 'search-result', query: 'nothing', total: 0, results: [] } as unknown as ContentPart
    const result = block(empty)
    expect(result.container.querySelectorAll('.term-search-item')).toHaveLength(0)
  })
})

describe('C05 SolidLinkBlock', () => {
  it('shows host/title/status and url raw form', () => {
    const result = block({ kind: 'link', url: 'https://example.com/guide', title: '使用指南', status: 200 } as ContentPart)
    expect(result.container.textContent).toContain('使用指南')
    expect(result.container.textContent).toContain('https://example.com/guide')
    expect(result.container.textContent).toContain('HTTP 200')
  })

  it('open/copy go through injected callbacks when allowed', async () => {
    const open = vi.fn()
    const copy = vi.fn()
    const result = block(
      { kind: 'link', url: 'https://example.com/guide' } as ContentPart,
      { open, copy },
    )
    const buttons = [...result.container.querySelectorAll('button')] as HTMLButtonElement[]
    await buttons.find(b => b.textContent === '打开')!.click()
    await buttons.find(b => b.textContent === '复制')!.click()
    expect(open).toHaveBeenCalledWith('https://example.com/guide')
    expect(copy).toHaveBeenCalledWith('https://example.com/guide')
  })

  it('disables actions for dangerous schemes with reason', () => {
    const open = vi.fn()
    const result = block(
      { kind: 'link', url: 'javascript:alert(1)' } as ContentPart,
      { open },
    )
    const buttons = [...result.container.querySelectorAll('button')] as HTMLButtonElement[]
    for (const button of buttons) {
      expect(button.hasAttribute('disabled')).toBe(true)
      expect(button.getAttribute('title')).toContain('白名单')
    }
  })

  it('non-search/link parts render nothing', () => {
    const result = block({ kind: 'text', text: 'plain' })
    expect(result.container.querySelector('.term-search-results')).toBeNull()
    expect(result.container.querySelector('.term-link-card')).toBeNull()
  })
})
