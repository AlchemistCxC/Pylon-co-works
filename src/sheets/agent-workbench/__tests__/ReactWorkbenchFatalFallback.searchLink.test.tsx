// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ReactFallbackContentPart } from '../ReactWorkbenchFatalFallback.tsx'
import type { ContentPart } from '../../../domains/workbench/content/contentPartSchema.ts'

describe('C05 React fatal content fallback', () => {
  it('keeps search results as an accessible list with source, location, and snippet', () => {
    render(<ReactFallbackContentPart part={{
      kind: 'search-result', query: 'renderer', total: 2,
      results: [
        { source: '/src/a.ts', rank: 1, location: { line: 7 }, snippet: 'first hit' },
        { source: 'https://example.com/guide', title: 'Guide', snippet: 'second hit' },
      ],
    } as ContentPart} />)

    expect(screen.getByRole('region', { name: '搜索结果 fallback：renderer' })).toBeTruthy()
    expect(screen.getAllByRole('listitem')).toHaveLength(2)
    expect(screen.getByText('/src/a.ts')).toBeTruthy()
    expect(screen.getByText('L7')).toBeTruthy()
    expect(screen.getByText('second hit')).toBeTruthy()
  })

  it('shows link identity/status without creating an unsafe browser anchor', () => {
    const { container } = render(<ReactFallbackContentPart part={{
      kind: 'link', url: 'javascript:alert(1)', title: 'Unsafe', status: 400,
    } as ContentPart} />)

    expect(screen.getByRole('region', { name: '链接 fallback：Unsafe' })).toHaveTextContent('HTTP 400')
    expect(screen.getByText('javascript:alert(1)')).toBeTruthy()
    expect(container.querySelector('a')).toBeNull()
  })
})
