// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@solidjs/testing-library'
import { createSignal } from 'solid-js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ToolInvocationSnapshot } from '../../../../domains/workbench/workbenchProjector.ts'
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

  it('presents generic input as a typed tree instead of one JSON pre block', () => {
    const execute = vi.fn()
    const { container } = render(() => <SolidToolInvocationCard
      renderKind="tool.generic"
      appearance={{ defaultCollapsed: false }}
      commands={{ execute, canExecute: type => type === 'clipboard.write' || type === 'resource.open' }}
      snapshot={{
        id: 'tool-object', name: 'CustomTool', status: 'running',
        input: { enabled: true, retries: 3, source_path: '/workspace/source.ts', options: { mode: 'safe' } },
      }}
    />)

    expect(container.querySelector('.tool-object-inspector')).not.toBeNull()
    expect(container.querySelector('.solid-tool-field > pre')).toBeNull()
    expect(container.querySelector('[data-primitive-type="boolean"]')).toHaveTextContent('true')
    expect(container.querySelector('[data-primitive-type="number"]')).toHaveTextContent('3')
    const resource = screen.getByRole('button', { name: '/workspace/source.ts' })
    resource.click()
    expect(execute).toHaveBeenCalledWith({ type: 'resource.open', payload: { path: '/workspace/source.ts' } })
  })

  it('keeps an expanded tool mounted while a streaming snapshot is updated', () => {
    const [snapshot, setSnapshot] = createSignal<ToolInvocationSnapshot>({
      id: 'stream-stable', name: 'Bash', semanticKind: 'tool.execute', status: 'running',
      input: { command: 'npm test' }, progress: { completed: 1, total: 2, message: 'running' },
    })
    const { container } = render(() => <SolidToolInvocationCard
      renderKind="tool.execute" appearance={{}} snapshot={snapshot()} />)

    screen.getByRole('button', { name: /Bash/ }).click()
    const card = container.querySelector('.term-tool')
    expect(container.querySelector('.tool-progress-track')).toHaveAttribute('aria-valuenow', '50')

    setSnapshot(previous => ({ ...previous, status: 'completed', progress: { completed: 2, total: 2, message: 'done' }, result: { rawOutput: 'passed' } }))

    expect(container.querySelector('.term-tool')).toBe(card)
    expect(container.querySelector('.term-tool-head')).toHaveAttribute('aria-expanded', 'true')
    expect(container.querySelector('.tool-progress-track')).toHaveAttribute('aria-valuenow', '100')
    expect(container.querySelector('.tool-plain-output')).toHaveTextContent('passed')
  })

  it('preserves a deep object branch while streamed input fields update', () => {
    const [snapshot, setSnapshot] = createSignal<ToolInvocationSnapshot>({
      id: 'stream-object', name: 'mcp__repo__search', capabilities: ['mcp'], status: 'running',
      input: { server_name: 'repo', arguments: { filters: { language: 'ts' } } },
    })
    const { container } = render(() => <SolidToolInvocationCard
      renderKind="tool.generic" appearance={{ defaultCollapsed: false }} snapshot={snapshot()} />)
    const nested = container.querySelector<HTMLDetailsElement>('.tool-object-branch .tool-object-branch')!
    nested.open = true
    fireEvent(nested, new Event('toggle'))
    expect(nested).toHaveAttribute('open')

    setSnapshot(previous => ({
      ...previous,
      progress: { completed: 1, total: 2 },
      input: { server_name: 'repo', arguments: { page: 2, filters: { language: 'ts', generated: false } } },
    }))

    expect(container.querySelector('.tool-object-branch .tool-object-branch')).toBe(nested)
    expect(nested).toHaveAttribute('open')
    expect(nested).toHaveTextContent('generated')
  })
})

describe('tool-kind presenters', () => {
  it('shows a read target, range and FileSheet deep link', () => {
    const execute = vi.fn()
    render(() => <SolidToolInvocationCard
      renderKind="tool.read" appearance={{ defaultCollapsed: false }}
      commands={{ execute, canExecute: type => type === 'resource.open' }}
      snapshot={{
        id: 'read-rich', name: 'Read', status: 'completed',
        input: { file_path: '/workspace/readme.md', start_line: 4, end_line: 12, encoding: 'utf-8' },
        result: { parts: [{ kind: 'text', text: 'preview' }] },
      }}
    />)

    expect(screen.getByRole('region', { name: '读取目标' })).toHaveTextContent('行 4–12')
    expect(screen.getByRole('region', { name: '读取目标' })).toHaveTextContent('编码 · utf-8')
    screen.getByRole('button', { name: '在 FileSheet 打开' }).click()
    expect(execute).toHaveBeenCalledWith({ type: 'resource.open', payload: { path: '/workspace/readme.md' } })
  })

  it('preserves URI semantics for read targets and generic inspector fields', () => {
    const execute = vi.fn()
    render(() => <SolidToolInvocationCard
      renderKind="tool.read" appearance={{ defaultCollapsed: false }}
      commands={{ execute, canExecute: type => type === 'resource.open' }}
      snapshot={{
        id: 'read-uri-rich', name: 'ReadResource', status: 'completed',
        input: { uri: 'acp-resource://server/readme', mirror_uri: 'git://example.test/repo' },
      }}
    />)

    screen.getByRole('button', { name: '在 FileSheet 打开' }).click()
    expect(execute).toHaveBeenNthCalledWith(1, {
      type: 'resource.open', payload: { uri: 'acp-resource://server/readme' },
    })
    screen.getByRole('button', { name: 'git://example.test/repo' }).click()
    expect(execute).toHaveBeenNthCalledWith(2, {
      type: 'resource.open', payload: { uri: 'git://example.test/repo' },
    })
  })

  it('shows command context and a safe plain output fallback', () => {
    const execute = vi.fn()
    const { container } = render(() => <SolidToolInvocationCard
      renderKind="tool.execute" appearance={{ defaultCollapsed: false }}
      commands={{ execute, canExecute: type => type === 'clipboard.write' }}
      snapshot={{
        id: 'exec-rich', name: 'Bash', status: 'completed',
        input: { command: 'npm test', cwd: '/workspace', env: { CI: '1' } },
        result: { rawOutput: '10 tests passed' },
      }}
    />)

    expect(screen.getByRole('region', { name: '执行命令' })).toHaveTextContent('npm test')
    expect(screen.getByRole('region', { name: '执行命令' })).toHaveTextContent('cwd · /workspace')
    expect(container.querySelector('.tool-plain-output')).toHaveTextContent('10 tests passed')
    expect(container.querySelector('.tool-output-fallback > pre')).not.toHaveTextContent('"10 tests passed"')
  })

  it('deepens generic agent, plan, skill, MCP, browser and artifact tools without changing catalog identity', () => {
    const { container } = render(() => <>
      <SolidToolInvocationCard renderKind="tool.execute" appearance={{ defaultCollapsed: false }} snapshot={{
        id: 'delegate-rich', name: 'Agent', semanticKind: 'tool.execute', action: 'delegate', status: 'running',
        input: { prompt: '审计消息重放边界', subagent_type: 'reviewer', model: 'sonnet', run_in_background: true },
      }} />
      <SolidToolInvocationCard renderKind="tool.generic" appearance={{ defaultCollapsed: false }} snapshot={{
        id: 'plan-rich', name: 'TodoWrite', action: 'plan', status: 'completed',
        input: { objective: '完成富渲染接线', todos: [{ content: '工具卡' }, { content: '生命周期卡' }] },
      }} />
      <SolidToolInvocationCard renderKind="tool.read" appearance={{ defaultCollapsed: false }} snapshot={{
        id: 'skill-rich', name: 'Skill', semanticKind: 'tool.read', action: 'skill', status: 'completed',
        input: { skill: 'diagnose', path: '/workspace/skills/diagnose/SKILL.md' },
      }} />
      <SolidToolInvocationCard renderKind="tool.generic" appearance={{ defaultCollapsed: false }} snapshot={{
        id: 'mcp-rich', name: 'mcp__github__search_code', capabilities: ['mcp', 'dynamic-schema'], status: 'completed',
        input: { server_name: 'github', arguments: { query: 'SolidToolInvocationCard' } },
      }} />
      <SolidToolInvocationCard renderKind="tool.execute" appearance={{ defaultCollapsed: false }} snapshot={{
        id: 'browser-rich', name: 'BrowserClick', semanticKind: 'tool.execute', action: 'click', status: 'completed',
        input: { url: 'https://example.com', selector: '#submit', tabId: 'tab-7' },
      }} />
      <SolidToolInvocationCard renderKind="tool.generic" appearance={{ defaultCollapsed: false }} snapshot={{
        id: 'artifact-rich', name: 'artifact_tool', status: 'completed',
        input: { title: '发布报告', path: '/workspace/report.md', format: 'markdown' },
      }} />
    </>)

    expect(screen.getByRole('region', { name: '代理委派' })).toHaveTextContent('审计消息重放边界')
    expect(screen.getByRole('region', { name: '代理委派' })).toHaveTextContent('后台运行')
    expect(screen.getByRole('region', { name: '计划与任务' })).toHaveTextContent('2 项')
    expect(screen.getByRole('region', { name: 'Skill 调用' })).toHaveTextContent('diagnose')
    expect(screen.getByRole('region', { name: 'MCP 调用' })).toHaveTextContent('github')
    expect(screen.getByRole('region', { name: 'MCP 调用' })).toHaveTextContent('search_code')
    expect(screen.getByRole('region', { name: '浏览器操作' })).toHaveTextContent('#submit')
    expect(screen.getByRole('region', { name: '产物操作' })).toHaveTextContent('发布报告')
    expect(container.querySelector('[data-tool-call-id="delegate-rich"] [data-tool-body-kind="tool.delegate"]')).not.toBeNull()
    expect(container.querySelector('[data-tool-call-id="mcp-rich"] .tool-object-inspector')).toHaveTextContent('SolidToolInvocationCard')
  })
})

describe('C06 edit/write nested content', () => {
  it('preserves custom URI semantics in edit summaries', () => {
    const execute = vi.fn()
    render(() => <SolidToolInvocationCard
      renderKind="tool.edit"
      appearance={{ defaultCollapsed: false }}
      snapshot={{
        id: 'edit-uri', name: 'EditResource', status: 'completed',
        input: { uri: 'acp-resource://workspace/document/7' },
        result: { parts: [{ kind: 'diff', path: 'acp-resource://workspace/document/7', lines: [] }] },
      }}
      commands={{ execute, canExecute: type => type === 'resource.open' }}
    />)

    const resources = screen.getAllByRole('button', { name: 'acp-resource://workspace/document/7' })
    expect(resources).toHaveLength(1)
    resources[0].click()
    expect(execute).toHaveBeenCalledWith({
      type: 'resource.open', payload: { uri: 'acp-resource://workspace/document/7' },
    })
  })

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
    expect(screen.getByRole('region', { name: '编辑摘要' })).toHaveTextContent('+1')
    expect(screen.getByRole('region', { name: '编辑摘要' })).toHaveTextContent('−1')
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
