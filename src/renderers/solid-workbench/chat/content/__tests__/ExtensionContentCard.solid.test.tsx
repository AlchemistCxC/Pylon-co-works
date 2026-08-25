// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@solidjs/testing-library'
import { createSignal } from 'solid-js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SolidExtensionContentCard } from '../ExtensionContentCard.solid.tsx'

afterEach(cleanup)

describe('C15 extension content card', () => {
  it('renders adjacent artifact text parts as one preview paragraph', () => {
    const { container } = render(() => <SolidExtensionContentCard kind="content.artifact" payload={{
      kind: 'artifact', artifactId: 'streamed-artifact', title: 'Streamed artifact', uri: 'artifact://streamed',
      parts: [{ kind: 'text', text: '连续' }, { kind: 'markdown', text: '预览' }],
    }} />)

    const preview = container.querySelector('.solid-extension-preview')!
    expect(preview).toHaveTextContent('连续预览')
    expect(preview.querySelectorAll('p')).toHaveLength(1)
  })

  it('renders typed metadata, recursive preview and consumes declared settings', () => {
    const { container } = render(() => <SolidExtensionContentCard kind="content.artifact" payload={{
      kind: 'artifact', artifactId: 'a', title: 'Audit report', uri: 'artifact://audit', version: 2,
      parts: [{ kind: 'text', text: 'preview body' }], raw: { vendorFuture: 9 },
    }} appearance={{ categoryPalette: 'accent', icon: 'document', metadataFields: ['identity', 'version', 'mime'], artifactPreviewSize: 240, unknownRawCollapsed: false }} commands={{ execute() {} }} />)
    expect(screen.getByRole('article', { name: /工件：Audit report/ })).toHaveTextContent('preview body')
    expect(container.querySelector('[data-category-palette="accent"]')).not.toBeNull()
    expect(container.querySelector('[data-icon="document"]')).not.toBeNull()
    expect(container.querySelector('.solid-extension-icon[data-icon="document"]')).toHaveTextContent('▣')
    expect(container.querySelector('.solid-extension-preview')).toHaveStyle({ maxHeight: '240px' })
    expect(container.querySelector('details')).toHaveAttribute('open')
  })

  it('gates MCP/artifact resource actions through semantic commands', () => {
    const execute = vi.fn()
    render(() => <SolidExtensionContentCard kind="content.mcp-resource" payload={{
      kind: 'mcp-resource', server: 'fs-mcp', tool: 'ReadMcpResource', resourceUri: 'file:///spec.md', connectionState: 'connected',
    }} appearance={{ mcpServerBadge: true, metadataFields: ['server', 'tool', 'status'] }} commands={{
      execute, canExecute: type => type === 'resource.open' || type === 'clipboard.write',
    }} />)
    expect(screen.getByText('fs-mcp')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '打开 MCP 资源' }))
    fireEvent.click(screen.getByRole('button', { name: '复制 MCP 资源地址' }))
    expect(execute).toHaveBeenNthCalledWith(1, { type: 'resource.open', payload: { uri: 'file:///spec.md' } })
    expect(execute).toHaveBeenNthCalledWith(2, { type: 'clipboard.write', payload: { text: 'file:///spec.md' } })
  })

  it('updates a typed payload in place when the active Slot receives a new snapshot', () => {
    const [payload, setPayload] = createSignal({
      kind: 'memory' as const, memoryId: 'memory-1', title: 'Initial memory', source: 'hermes', status: 'stored',
    })
    render(() => <SolidExtensionContentCard kind="content.memory" payload={payload()} commands={{ execute() {} }} />)
    const card = screen.getByRole('article', { name: '记忆：Initial memory' })

    setPayload({ ...payload(), title: 'Updated memory', status: 'recalled' })

    expect(screen.getByRole('article', { name: '记忆：Updated memory' })).toBe(card)
    expect(card).toHaveTextContent('recalled')
  })

  it('renders hook status/error without event input and honors collapse/duration settings', () => {
    render(() => <SolidExtensionContentCard kind="system.hook" payload={{
      phase: 'turn.failed', owner: { pluginId: 'plugin.audit', handlerId: 'after-turn' },
      status: 'failed', durationMs: 21, decision: 'continue', error: { message: 'hook exploded', code: 'HOOK_FAILED' },
    }} appearance={{ defaultCollapsed: true, showDuration: true, metadataFields: ['owner', 'status'] }} commands={{ execute() {} }} />)
    const card = screen.getByRole('status', { name: /Hook：turn.failed/ })
    expect(card).toHaveTextContent('21 ms')
    expect(card).toHaveTextContent('hook exploded')
    expect(card.querySelector('details')).not.toHaveAttribute('open')
    expect(card).not.toHaveTextContent('event input')
  })

  it('applies hook duration setting updates without remounting the card', () => {
    const [appearance, setAppearance] = createSignal({ showDuration: true, defaultCollapsed: false })
    render(() => <SolidExtensionContentCard kind="system.hook" payload={{
      phase: 'turn.completed', owner: { pluginId: 'plugin.audit', handlerId: 'after-turn' },
      status: 'continued', durationMs: 21,
    }} appearance={appearance()} commands={{ execute() {} }} />)
    const card = screen.getByRole('status', { name: /Hook：turn.completed/ })
    expect(card).toHaveTextContent('21 ms')
    expect(card).toHaveTextContent('plugin.audit · after-turn')

    setAppearance({ showDuration: false, defaultCollapsed: false })

    expect(card).not.toHaveTextContent('21 ms')
  })
})
