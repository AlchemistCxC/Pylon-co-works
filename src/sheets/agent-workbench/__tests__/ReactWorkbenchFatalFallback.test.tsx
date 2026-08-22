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

  it('keeps canonical C02 file, document, and resource parts visible without exposing binary raw', () => {
    const current: WorkbenchDocument = {
      ...document(3, ''),
      messages: [{
        ...document(3, '').messages[0]!,
        parts: [
          { kind: 'file-reference', path: 'C:\\work\\report.md', displayName: 'report.md' },
          { kind: 'file-selection', path: '/workspace/main.ts', selection: { start: { line: 4, column: 2 }, end: { line: 7 } }, language: 'ts', previewText: 'selected fallback text' },
          { kind: 'document', title: 'inline-spec.md', text: 'safe inline body', mimeType: 'text/markdown' },
          { kind: 'resource', uri: 'file:///docs/private.pdf', mimeType: 'application/pdf', hasBlob: true },
        ],
      }],
    }
    const reader: WorkbenchDocumentReader = {
      getSnapshot: () => current,
      subscribe: () => () => {},
      getSlice: () => undefined as never,
      subscribeSlice: () => () => {},
    }
    const { container } = render(<ReactWorkbenchFatalFallback
      document={reader}
      failure={{ suiteId: 'builtin.solid', phase: 'slot', message: 'content slot failed' }}
      onRetry={vi.fn()}
      onSelectSuite={vi.fn()}
      onOpenDiagnostics={vi.fn()}
    />)

    expect(screen.getByText('report.md')).toBeInTheDocument()
    expect(screen.getByText('C:\\work\\report.md')).toBeInTheDocument()
    expect(screen.getByText('L4:2–L7')).toBeInTheDocument()
    expect(screen.getByText('selected fallback text')).toBeInTheDocument()
    expect(screen.getByText('inline-spec.md')).toBeInTheDocument()
    expect(screen.getByText('safe inline body')).toBeInTheDocument()
    expect(screen.getByText('file:///docs/private.pdf')).toBeInTheDocument()
    expect(screen.getByText('二进制内容不内联展示')).toBeInTheDocument()
    expect(container.textContent).not.toContain('JVBERi0xLjQK')
    expect(container.querySelectorAll('[data-react-content-kind]')).toHaveLength(4)
  })
})
