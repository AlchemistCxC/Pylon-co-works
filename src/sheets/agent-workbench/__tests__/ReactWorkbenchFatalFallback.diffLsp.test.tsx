// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { ContentPart } from '../../../domains/workbench/content/contentPartSchema.ts'
import { ReactFallbackContentPart } from '../ReactWorkbenchFatalFallback.tsx'

describe('C06 React fatal content fallback', () => {
  it('keeps normalized diff and LSP evidence readable without raw/provider branching', () => {
    render(<>
      <ReactFallbackContentPart part={{
        kind: 'diff', path: '/src/fallback.ts', status: 'modified',
        lines: [{ kind: 'removed', text: 'old' }, { kind: 'added', text: 'new' }],
        rawPatch: 'provider raw must stay folded',
      } as ContentPart} />
      <ReactFallbackContentPart part={{
        kind: 'diagnostic-lsp', severity: 'error', code: 'TS1005', source: 'typescript',
        message: 'semicolon expected', path: '/src/fallback.ts',
        range: { start: { line: 4, character: 2 } },
        related: [{ message: 'related declaration', path: '/src/types.ts' }],
      } as ContentPart} />
    </>)

    expect(screen.getByRole('region', { name: 'Diff fallback：/src/fallback.ts' })).toHaveTextContent('old')
    expect(screen.getByRole('region', { name: 'Diff fallback：/src/fallback.ts' })).toHaveTextContent('new')
    expect(screen.getByText('Raw 审计信息')).toBeTruthy()
    expect(screen.getByRole('alert', { name: 'LSP error fallback：semicolon expected' })).toHaveTextContent('TS1005 · typescript')
    expect(screen.getByRole('list', { name: 'LSP 关联位置 fallback' })).toHaveTextContent('/src/types.ts')
  })
})
