// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { ContentPart } from '../../../domains/workbench/content/contentPartSchema.ts'
import { ReactFallbackContentPart } from '../ReactWorkbenchFatalFallback.tsx'

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
  })
})
