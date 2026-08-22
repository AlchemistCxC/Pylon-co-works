// @vitest-environment jsdom
import { render } from '@solidjs/testing-library'
import { describe, expect, it, vi } from 'vitest'
import { SolidLogBlock, SolidTerminalBlock } from '../TerminalBlock.solid.tsx'
import type { ContentPart } from '../../../../../domains/workbench/content/contentPartSchema.ts'

/**
 * C07 RED：终端/日志卡契约。
 *
 * - stdout/stderr 分列（err 视觉标记），ANSI 转义序列纯文本化；
 * - exit/killed/timeout/non-zero 分开显示；
 * - truncation 显示 captured/omitted；迟到 chunk 标记呈现；
 * - copy capability-gated。
 */

const terminalPart = {
  kind: 'terminal',
  command: 'npm test',
  streams: [
    { stream: 'stdout', text: 'running tests...', ordinal: 0 },
    { stream: 'stderr', text: 'warning: deprecated', ordinal: 1 },
    { stream: 'stdout', text: '\u001b[32m3 passed\u001b[0m', ordinal: 2 },
  ],
  exitCode: 0,
  status: 'completed',
} as unknown as ContentPart

describe('C07 SolidTerminalBlock', () => {
  it('renders separated stdout/stderr lines with stream tags', () => {
    const result = render(() => <SolidTerminalBlock part={terminalPart} />)
    const stdout = result.container.querySelectorAll('.term-stream-stdout')
    const stderr = result.container.querySelectorAll('.term-stream-stderr')
    expect(stdout.length).toBe(2)
    expect(stderr.length).toBe(1)
    // ANSI 序列纯文本化：绿色码不出现
    expect(result.container.textContent).not.toContain('\u001b[32m')
    expect(result.container.textContent).toContain('3 passed')
  })

  it('shows exit 0 for success and non-zero exit distinctly', () => {
    const ok = render(() => <SolidTerminalBlock part={terminalPart} />)
    expect(ok.container.textContent).toContain('exit 0')

    const failed = render(() => <SolidTerminalBlock part={{ ...terminalPart, exitCode: 137 } as unknown as ContentPart} />)
    expect(failed.container.textContent).toContain('exit 137')
    expect(failed.container.querySelector('[data-tone="failed"]')).not.toBeNull()
  })

  it('shows timeout and killed termination reasons separately from exit code', () => {
    const timeout = render(() => <SolidTerminalBlock part={{ ...terminalPart, terminatedBy: 'timeout' } as unknown as ContentPart} />)
    expect(timeout.container.textContent).toContain('超时终止')
    const killed = render(() => <SolidTerminalBlock part={{ ...terminalPart, terminatedBy: 'killed' } as unknown as ContentPart} />)
    expect(killed.container.textContent).toContain('killed')
  })

  it('shows truncation with captured/omitted counts', () => {
    const truncPart = {
      ...terminalPart,
      truncation: { capturedLines: 3, omittedLines: 9999 },
    } as unknown as ContentPart
    const result = render(() => <SolidTerminalBlock part={truncPart} />)
    expect(result.container.textContent).toContain('保留 3 行')
    expect(result.container.textContent).toContain('省略 9999 行')
  })

  it('copy goes through injected callback with sanitized text', async () => {
    const copy = vi.fn()
    const result = render(() => <SolidTerminalBlock part={terminalPart} actions={{ copy }} />)
    const button = [...result.container.querySelectorAll('button')].find(b => b.textContent === '复制')!
    await button.click()
    expect(copy).toHaveBeenCalled()
    const copiedText = copy.mock.calls[0]![0] as string
    expect(copiedText).toContain('[err] warning: deprecated')
    expect(copiedText).not.toContain('\u001b[')
  })

  it('late chunks are flagged and rendered separately', () => {
    const late = {
      ...terminalPart,
      streams: [
        ...(terminalPart as unknown as { streams: unknown[] }).streams,
        { stream: 'stdout', text: 'late arrival', ordinal: 9, lateAfterTerminal: true },
      ],
    } as unknown as ContentPart
    const result = render(() => <SolidTerminalBlock part={late} />)
    expect(result.container.textContent).toContain('迟到输出')
  })
})

describe('C07 SolidLogBlock', () => {
  it('renders entries with levels and synthetic timestamp flag', () => {
    const logPart = {
      kind: 'log',
      source: 'build-worker',
      entries: [
        { level: 'info', text: 'compiling', timestampConfidence: 'observed' },
        { level: 'warn', text: 'slow transform', timestampConfidence: 'synthetic' },
      ],
    } as unknown as ContentPart
    const result = render(() => <SolidLogBlock part={logPart} />)
    expect(result.container.textContent).toContain('compiling')
    expect(result.container.textContent).toContain('时间戳为合成')
    expect(result.container.querySelector('.term-log-warn')).not.toBeNull()
  })
})
