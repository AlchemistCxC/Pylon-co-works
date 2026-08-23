// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { createWorkbenchDocument, type WorkbenchDocument } from '../../../domains/workbench/workbenchProjector.ts'
import type { WorkbenchDocumentReader } from '../../../renderers/solid-workbench/workbenchHostPort.ts'
import ReactWorkbenchFatalFallback from '../ReactWorkbenchFatalFallback.tsx'

describe('React Workbench fatal fallback C15', () => {
  it('keeps typed content, hooks and missing-plugin extension history readable with gated actions', () => {
    const empty = createWorkbenchDocument('c15-fallback')
    const current: WorkbenchDocument = {
      ...empty,
      revision: 3,
      messages: [{
        id: 'message-c15', role: 'assistant', content: '', identity: {}, source: { provider: 'peri', sourceId: 'wire-1' },
        sequence: 1, running: false, time: '2026-08-24T00:00:00.000Z', parts: [
          { kind: 'memory', memoryId: 'mem-1', title: 'Dark preference', source: 'hermes', status: 'recalled' },
          { kind: 'mcp-resource', server: 'fs-mcp', resourceUri: 'file:///spec.md', connectionState: 'connected' },
          { kind: 'artifact', artifactId: 'art-1', title: 'Audit report', uri: 'artifact://audit', parts: [{ kind: 'text', text: 'artifact preview' }] },
        ],
      }],
      extensions: [
        { id: 'hook-1', kind: 'system.hook', payload: { phase: 'turn.failed', owner: { pluginId: 'plugin.audit', handlerId: 'after' }, status: 'failed', error: { message: 'hook exploded' } }, fallback: [], identity: {}, source: { provider: 'peri', sourceId: 'hook-wire' }, provenance: { origin: 'local-observed', trust: 'authoritative' }, sequence: 2, time: '2026-08-24T00:00:01.000Z' },
        { id: 'plugin-1', kind: 'plugin.demo/result', payload: { status: 'done' }, fallback: [{ kind: 'unknown', originalType: 'plugin.demo/result', summary: 'missing plugin renderer', raw: { status: 'done' }, truncated: false }], identity: {}, source: { provider: 'peri', sourceId: 'plugin-wire' }, provenance: { origin: 'local-observed', trust: 'authoritative' }, sequence: 3, time: '2026-08-24T00:00:02.000Z' },
      ],
    }
    const reader: WorkbenchDocumentReader = { getSnapshot: () => current, subscribe: () => () => {}, getSlice: () => undefined as never, subscribeSlice: () => () => {} }
    const onOpenResource = vi.fn()
    const onCopyResource = vi.fn()
    render(<ReactWorkbenchFatalFallback document={reader} failure={{ suiteId: 'builtin.solid', phase: 'mount', message: 'failed' }}
      onRetry={vi.fn()} onSelectSuite={vi.fn()} onOpenDiagnostics={vi.fn()}
      onOpenResource={onOpenResource} onCopyResource={onCopyResource} />)

    expect(screen.getByText('Dark preference')).toBeInTheDocument()
    expect(screen.getByText('artifact preview')).toBeInTheDocument()
    expect(screen.getByRole('status', { name: /Hook fallback：turn.failed/ })).toHaveTextContent('hook exploded')
    const missingPlugin = screen.getByRole('note', { name: /扩展事件 fallback：plugin.demo\/result/ })
    expect(missingPlugin).toHaveTextContent('missing plugin renderer')
    expect(missingPlugin).toHaveTextContent('peri · plugin-wire')
    expect(missingPlugin).toHaveTextContent('local-observed · authoritative')
    fireEvent.click(screen.getByRole('button', { name: '打开 MCP 资源' }))
    fireEvent.click(screen.getByRole('button', { name: '复制 MCP 资源地址' }))
    expect(onOpenResource).toHaveBeenCalledWith('file:///spec.md')
    expect(onCopyResource).toHaveBeenCalledWith('file:///spec.md')
  })
})
