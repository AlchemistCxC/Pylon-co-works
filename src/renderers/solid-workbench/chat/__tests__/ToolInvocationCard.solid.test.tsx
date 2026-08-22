// @vitest-environment jsdom
import { cleanup, render, screen } from '@solidjs/testing-library'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SolidToolInvocationCard } from '../ToolInvocationCard.solid.tsx'

afterEach(cleanup)

describe('C04 SolidToolInvocationCard', () => {
  it('renders nested canonical parts with an accessible lifecycle status', () => {
    const { container } = render(() => <SolidToolInvocationCard
      renderKind="tool.generic"
      appearance={{ reducedMotion: true, defaultCollapsed: false, showDuration: true }}
      snapshot={{
        id: 'tool-nested', title: '运行检查', name: 'ProviderExec', status: 'completed',
        input: { command: 'npm test' },
        result: {
          status: 'completed', durationMs: 1450,
          parts: [
            { kind: 'markdown', text: '**passed**' },
            { kind: 'code', text: 'const ok = true', language: 'ts' },
          ],
        },
      }}
    />)

    const card = screen.getByRole('status', { name: '工具：运行检查，已完成' })
    expect(card).toHaveAttribute('data-reduced-motion', 'true')
    expect(card).toHaveTextContent('ProviderExec')
    expect(card).toHaveTextContent('1.4s')
    expect(screen.getByText('**passed**')).toBeTruthy()
    expect(container.querySelector('.term-code-block')).not.toBeNull()
  })

  it('redacts and truncates finite raw audit output when explicitly enabled', () => {
    const secret = 'sk-must-not-render'
    const { container } = render(() => <SolidToolInvocationCard
      renderKind="tool.generic"
      appearance={{ defaultCollapsed: false, showRaw: true }}
      snapshot={{
        id: 'tool-raw', name: 'FutureTool', status: 'failed',
        rawInput: { apiKey: secret, huge: 'x'.repeat(20_000) },
        result: {
          status: 'failed',
          error: { userSummary: 'safe error', technicalMessage: 'safe detail', code: 'SAFE', recoverability: 'none' },
          rawOutput: { token: secret },
        },
      }}
    />)

    expect(container.textContent).not.toContain(secret)
    expect(container.textContent).toContain('[REDACTED]')
    expect(container.textContent).toContain('truncated')
    expect(screen.getByRole('alert')).toHaveTextContent('safe error')
    expect(screen.getByRole('alert')).toHaveTextContent('SAFE')
  })

  it('renders normalized input parts and locations as generic lifecycle content', () => {
    const { container } = render(() => <SolidToolInvocationCard
      renderKind="tool.input"
      appearance={{ defaultCollapsed: false }}
      snapshot={{
        id: 'tool-input-parts', name: 'FutureTool', status: 'running',
        input: [
          { kind: 'markdown', text: '**argument**' },
          { kind: 'code', text: 'npm test', language: 'sh' },
        ],
        locations: [{ path: '/workspace/a.ts', line: 7 }],
      }}
    />)

    expect(screen.getByText('**argument**')).toBeTruthy()
    expect(container.querySelector('[data-tool-input-parts] .term-code-block')).not.toBeNull()
    expect(screen.getByText('位置')).toBeTruthy()
    expect(container.querySelector('.solid-tool-locations')).toHaveTextContent('/workspace/a.ts')
  })

  it('keeps aria-controls unique for distinct provider tool ids', () => {
    const appearance = { defaultCollapsed: false }
    render(() => <>
      <SolidToolInvocationCard renderKind="tool.generic" appearance={appearance} snapshot={{ id: 'tool/a', status: 'running' }} />
      <SolidToolInvocationCard renderKind="tool.generic" appearance={appearance} snapshot={{ id: 'tool?a', status: 'running' }} />
    </>)

    const controls = screen.getAllByRole('button').map(button => button.getAttribute('aria-controls'))
    expect(new Set(controls).size).toBe(2)
    for (const id of controls) expect(id && document.getElementById(id)).not.toBeNull()
  })

  it('deepens search/link output parts and routes them through semantic commands', () => {
    const execute = vi.fn()
    const { container } = render(() => <SolidToolInvocationCard
      renderKind="tool.search"
      appearance={{ defaultCollapsed: false, defaultExpanded: true }}
      commands={{ canExecute: type => type === 'resource.open', execute }}
      snapshot={{
        id: 'tool-search', name: 'Search', semanticKind: 'tool.search', status: 'completed',
        result: { status: 'completed', parts: [{ kind: 'search-result', results: [{ source: 'https://example.com/a', title: 'A' }] }] },
      }}
    />)

    expect(container.querySelector('.term-search-results')).not.toBeNull()
    expect(container.querySelector('[data-tool-part-kind="search-result"]')).toBeNull()
    screen.getByRole('button', { name: '打开' }).click()
    expect(execute).toHaveBeenCalledWith({ type: 'resource.open', payload: { uri: 'https://example.com/a' } })
  })
})
