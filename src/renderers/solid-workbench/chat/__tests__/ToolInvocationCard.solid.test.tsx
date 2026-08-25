// @vitest-environment jsdom
import { cleanup, render, screen } from '@solidjs/testing-library'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SolidToolInvocationCard } from '../ToolInvocationCard.solid.tsx'

afterEach(cleanup)

describe('C04 SolidToolInvocationCard', () => {
  it('defaults to collapsed when no appearance override is supplied', () => {
    const { container } = render(() => <SolidToolInvocationCard
      renderKind="tool.generic"
      appearance={{}}
      snapshot={{
        id: 'tool-default-collapsed', name: 'Read', status: 'completed',
        result: { parts: [{ kind: 'text', text: 'hidden until requested' }] },
      }}
    />)

    expect(container.querySelector('.term-tool-head')).toHaveAttribute('aria-expanded', 'false')
    expect(container.querySelector('.term-tool-body')).toBeNull()
  })

  it('renders adjacent streamed text output as one semantic block', () => {
    const { container } = render(() => <SolidToolInvocationCard
      renderKind="tool.generic"
      appearance={{ defaultCollapsed: false }}
      snapshot={{
        id: 'tool-streamed-text', name: 'FutureTool', status: 'completed',
        result: { parts: [{ kind: 'text', text: '连续' }, { kind: 'text', text: '输出' }] },
      }}
    />)

    const output = container.querySelector('.solid-tool-parts')!
    expect(output).toHaveTextContent('连续输出')
    expect(output.querySelectorAll('[data-tool-part-kind]')).toHaveLength(1)
  })

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

  it('renders adjacent streamed input text parts as one semantic block', () => {
    const { container } = render(() => <SolidToolInvocationCard
      renderKind="tool.input"
      appearance={{ defaultCollapsed: false }}
      snapshot={{
        id: 'tool-streamed-input', name: 'FutureTool', status: 'running',
        input: [{ kind: 'text', text: '连续' }, { kind: 'markdown', text: '参数' }],
      }}
    />)

    const input = container.querySelector('[data-tool-input-parts]')!
    expect(input).toHaveTextContent('连续参数')
    expect(input.querySelectorAll('[data-tool-part-kind]')).toHaveLength(1)
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

describe('C06 edit/write nested content', () => {
  it('renders normalized diff result parts without falling back to JSON', () => {
    const { container } = render(() => <SolidToolInvocationCard
      renderKind="tool.edit"
      appearance={{ defaultCollapsed: false, wordDiff: false }}
      snapshot={{
        id: 'edit-diff', name: 'Edit', title: '编辑文件', semanticKind: 'tool.edit', status: 'completed',
        result: {
          status: 'completed',
          parts: [{
            kind: 'diff', path: '/src/tool.ts',
            lines: [{ kind: 'removed', text: 'old' }, { kind: 'added', text: 'new' }],
          }],
        },
      }}
      commands={{ execute: vi.fn(), canExecute: () => false }}
    />)

    expect(screen.getByRole('region', { name: 'Diff：/src/tool.ts' })).toBeTruthy()
    expect(container.querySelector('[data-tool-part-kind="diff"]')).toBeNull()
    expect(container.textContent).not.toContain('"kind": "diff"')
  })
})

describe('C07 execute nested content', () => {
  it('renders terminal and log result parts through typed components and command port', () => {
    const execute = vi.fn()
    const { container } = render(() => <SolidToolInvocationCard
      renderKind="tool.execute"
      appearance={{ defaultCollapsed: false, showCopy: true }}
      snapshot={{
        id: 'execute-1', name: 'Bash', semanticKind: 'tool.execute', status: 'completed',
        result: {
          status: 'completed',
          parts: [
            { kind: 'terminal', command: 'npm test', streams: [{ stream: 'stdout', text: 'passed', ordinal: 0 }] },
            { kind: 'log', source: 'runner', entries: [{ level: 'info', text: 'finished' }] },
          ],
        },
      }}
      commands={{ execute, canExecute: type => type === 'clipboard.write' }}
    />)

    expect(container.querySelector('.term-terminal-card')).toHaveTextContent('passed')
    expect(container.querySelector('.term-log-card')).toHaveTextContent('finished')
    screen.getByRole('button', { name: '复制' }).click()
    expect(execute).toHaveBeenCalledWith({ type: 'clipboard.write', payload: { text: 'passed' } })
    expect(container.textContent).not.toContain('"kind": "terminal"')
  })
})
