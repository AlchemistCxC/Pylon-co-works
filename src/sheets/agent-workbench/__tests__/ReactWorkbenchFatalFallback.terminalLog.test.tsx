// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { createUnknownContentPart, type ContentPart } from '../../../domains/workbench/content/contentPartSchema.ts'
import { createWorkbenchDocument, type WorkbenchDocument } from '../../../domains/workbench/workbenchProjector.ts'
import type { WorkbenchDocumentReader } from '../../../renderers/solid-workbench/workbenchHostPort.ts'
import ReactWorkbenchFatalFallback, { ReactFallbackContentPart } from '../ReactWorkbenchFatalFallback.tsx'

describe('C07 React fatal content fallback', () => {
  it('keeps terminal/log streams, exit, and truncation readable without exposing env secrets', () => {
    render(<>
      <ReactFallbackContentPart part={{
        kind: 'terminal', command: 'npm test', processId: 'proc-1', sessionId: 'shell-1',
        streams: [
          { stream: 'stdout', text: '\u001b[32mpassed\u001b[0m', ordinal: 0 },
          { stream: 'stderr', text: 'warning', ordinal: 1 },
        ],
        exitCode: 2,
        env: { API_KEY: '[REDACTED]', NODE_ENV: 'test' },
        truncation: { capturedLines: 2, omittedLines: 50, omittedBytes: 4096 },
      } as ContentPart} />
      <ReactFallbackContentPart part={{
        kind: 'log', source: 'runner',
        entries: [{ level: 'warn', text: 'slow', timestamp: '10:01', timestampConfidence: 'synthetic' }],
        truncation: { capturedLines: 1, omittedLines: 25, omittedBytes: 2048 },
      } as ContentPart} />
    </>)

    const terminal = screen.getByRole('region', { name: '终端 fallback：npm test' })
    expect(terminal).toHaveTextContent('passed')
    expect(terminal).toHaveTextContent('stderr · warning')
    expect(terminal).toHaveTextContent('exit 2')
    expect(terminal).toHaveTextContent('省略 50 行')
    expect(terminal).toHaveTextContent('4096 bytes')
    expect(terminal.textContent).not.toContain('\u001b[')
    expect(terminal.textContent).not.toContain('API_KEY')

    const log = screen.getByRole('log', { name: '日志 fallback：runner' })
    expect(log).toHaveTextContent('warn · 10:01 · slow')
    expect(log).toHaveTextContent('时间戳为合成')
    expect(log).toHaveTextContent('日志已截断')
    expect(log).toHaveTextContent('省略 25 行')
    expect(log).toHaveTextContent('2048 bytes')
  })

  it('keeps process identity, output, malformed evidence, and synthetic provenance readable', () => {
    const current: WorkbenchDocument = {
      ...createWorkbenchDocument('local:c07'),
      revision: 7,
      activities: [{
        id: 'process-1', kind: 'activity', activityKind: 'process', semanticKind: 'activity.process',
        title: 'build worker', status: 'completed', processId: 'proc-7', sessionId: 'shell-2',
        parts: [
          { kind: 'terminal', streams: [{ stream: 'stdout', text: 'build passed' }], exitCode: 0 },
          { kind: 'log', source: 'worker', entries: [{ level: 'warn', text: 'slow build' }] },
          createUnknownContentPart('terminal', { kind: 'terminal', streams: [{ stream: 'stdin', text: 'malformed evidence' }] }),
        ],
        provenance: {
          origin: 'plugin', trust: 'unverified', orderConfidence: 'observed',
          synthetic: { reason: 'terminal response observed' },
        },
        orphan: false, sequence: 7,
      }],
    }
    const reader: WorkbenchDocumentReader = {
      getSnapshot: () => current,
      subscribe: () => () => {},
      getSlice: () => undefined as never,
      subscribeSlice: () => () => {},
    }
    render(<ReactWorkbenchFatalFallback
      document={reader}
      failure={{ suiteId: 'builtin.solid', phase: 'slot', message: 'process slot failed' }}
      onRetry={vi.fn()}
      onSelectSuite={vi.fn()}
      onOpenDiagnostics={vi.fn()}
    />)

    const process = screen.getByRole('status', { name: '进程 fallback：build worker，completed' })
    expect(process).toHaveTextContent('proc-7 · shell-2')
    expect(process).toHaveTextContent('build passed')
    expect(process).toHaveTextContent('slow build')
    expect(process).toHaveTextContent('malformed evidence')
    expect(process).toHaveTextContent('合成生命周期：terminal response observed')
    expect(screen.queryByRole('status', { name: '子代理 fallback：build worker，completed' })).not.toBeInTheDocument()
  })
})
