// @vitest-environment jsdom
import { act, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { createWorkbenchDocument, type WorkbenchDocument } from '../../../domains/workbench/workbenchProjector.ts'
import type { WorkbenchDocumentReader } from '../../../renderers/solid-workbench/workbenchHostPort.ts'
import ReactWorkbenchFatalFallback from '../ReactWorkbenchFatalFallback.tsx'

function document(revision: number, text: string): WorkbenchDocument {
  const empty = createWorkbenchDocument('local:a')
  return {
    ...empty,
    revision,
    messages: [{
      id: `message-${revision}`, role: 'assistant', content: text, parts: [], identity: {},
      source: { provider: 'peri', sourceId: `source-${revision}` }, sequence: revision,
      running: false, time: '2026-08-22T00:00:00.000Z',
    }],
  }
}

describe('React Workbench fatal fallback', () => {
  it('直接订阅同一 document revision，不创建 replay/message store', () => {
    let current = document(1, 'before failure')
    const listeners = new Set<() => void>()
    const reader: WorkbenchDocumentReader = {
      getSnapshot: () => current,
      subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener) },
      getSlice: () => undefined as never,
      subscribeSlice: (_slice, listener) => { listeners.add(listener); return () => listeners.delete(listener) },
    }
    render(<ReactWorkbenchFatalFallback
      document={reader}
      failure={{ suiteId: 'builtin.solid', phase: 'mount', message: 'solid failed' }}
      onRetry={vi.fn()}
      onSelectSuite={vi.fn()}
      onOpenDiagnostics={vi.fn()}
    />)
    expect(screen.getByRole('alert')).toHaveAttribute('data-document-revision', '1')
    expect(screen.getByText('before failure')).toBeInTheDocument()

    act(() => {
      current = document(2, 'after failure')
      for (const listener of listeners) listener()
    })
    expect(screen.getByRole('alert')).toHaveAttribute('data-document-revision', '2')
    expect(screen.getByText('after failure')).toBeInTheDocument()
  })
})
