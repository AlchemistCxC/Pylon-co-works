// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from '@solidjs/testing-library'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mountSolidWorkbench, mountSolidWorkbenchFromHostPort } from '../mountSolidWorkbench.solid.tsx'
import { createPreviewWorkbenchServices } from '../__fixtures__/previewWorkbenchServices.ts'
import { createWorkbenchEnvelope, type WorkbenchEventEnvelope } from '../../../domains/workbench/events/workbenchEventSchema.ts'
import { createWorkbenchDocument, projectWorkbench, reduceWorkbenchEvent } from '../../../domains/workbench/workbenchProjector.ts'
import { createWorkbenchHostPort } from '../workbenchHostPort.ts'
import type { WorkbenchCapabilitySnapshot } from '../workbenchHostPort.ts'
import { RendererSuiteHost } from '../../../host/renderer-suite/rendererSuiteHost.ts'
import type { RendererActivationSnapshot, RendererSlotContribution, RendererSuiteContribution } from '../../../plugin-runtime/renderers/rendererSuiteTypes.ts'
import type { RegistryEntry } from '../../../plugin-runtime/registry/types.ts'
import { BUILTIN_TEXT_RENDER_KINDS } from '../../../domains/rendererContent/textRenderKindCatalog.ts'
import { BUILTIN_TOOL_RENDER_KINDS } from '../../../domains/rendererContent/toolRenderKindCatalog.ts'
import { BUILTIN_EXECUTION_RENDER_KINDS } from '../../../domains/rendererContent/executionRenderKindCatalog.ts'
import { BUILTIN_INTERACTION_RENDER_KINDS } from '../../../domains/rendererContent/interactionRenderKindCatalog.ts'
import { createBuiltinSolidContentSlot } from '../builtinSolidRendererSuite.ts'
import { DEFAULTS } from '../../../domains/theme/themeDefaults.ts'
import type { WorkbenchSessionCreationStore } from '../../../domains/workbench/workbenchCommandFacade.ts'
import { createAgentWorkbenchCommandFacade } from '../../../sheets/agent-workbench/agentWorkbenchCommands.ts'
import type { Session } from '../../../identityStore.ts'
import { selectDisplayStream } from '../solidWorkbenchProjectionSupport.ts'

const hosts: HTMLElement[] = []
const servicesList: ReturnType<typeof createPreviewWorkbenchServices>[] = []

afterEach(() => {
  cleanup()
  for (const services of servicesList.splice(0)) services.destroy()
  for (const host of hosts.splice(0)) host.remove()
})

describe('canonical/transient display owner', () => {
  it('selects exactly one owner across short/equal/long prefixes and terminal precedence', () => {
    const canonical = [{ id: 'm', segmentId: 'm', role: 'assistant' as const, content: 'abc', parts: [], identity: {}, source: { provider: 'p', sessionId: 's', sourceId: 'p' }, sequence: 1, running: true, time: '' }]
    expect(selectDisplayStream(canonical, 'assistant', 'abcdef')).toMatchObject({ owner: 'transient', text: 'abcdef' })
    expect(selectDisplayStream(canonical, 'assistant', 'abc')).toMatchObject({ owner: 'canonical', text: 'abc' })
    expect(selectDisplayStream(canonical, 'assistant', 'ab')).toMatchObject({ owner: 'canonical', text: 'abc' })
    expect(selectDisplayStream([{ ...canonical[0]!, running: false }], 'assistant', 'abcdef')).toMatchObject({ owner: 'canonical', text: 'abc' })
    const conflict = selectDisplayStream([{ ...canonical[0]!, running: false }], 'assistant', 'xyz')
    expect(conflict).toMatchObject({ owner: 'transient', text: 'xyz' })
    expect(conflict.canonical).toBeUndefined()
    expect(selectDisplayStream(canonical, 'assistant', 'xyz', { turnId: 'new-turn' })).toMatchObject({
      owner: 'transient', text: 'xyz',
    })
    const identified = [{ ...canonical[0]!, identity: { messageId: 'm' } }]
    expect(selectDisplayStream(identified, 'assistant', 'abcdef', { messageId: 'm' })).toMatchObject({
      owner: 'transient', text: 'abcdef', canonical: identified[0],
    })
  })
})

function mountPreview(capabilities?: WorkbenchCapabilitySnapshot) {
  const host = document.createElement('div')
  document.body.append(host)
  hosts.push(host)
  const services = createPreviewWorkbenchServices()
  servicesList.push(services)
  const hostPort = capabilities ? createWorkbenchHostPort({
    ...services,
    suiteId: 'builtin.solid',
    sheetId: 'sheet-a',
    sessionOwnerKey: 'owner-preview',
    sessionId: 'preview-session',
    capabilities,
  }) : undefined
  const lifecycle = mountSolidWorkbench({
    host,
    input: {
      sheetId: 'sheet-a',
      sessionId: 'preview-session',
      preview: true,
      rightInset: 24,
      reducedMotion: true,
    },
    services,
    hostPort,
  })
  return { host, services, lifecycle }
}

describe('mountSolidWorkbench', () => {
  it('按 canonical sequence 把工具活动插入用户消息与助手回复之间', async () => {
    const { host, services } = mountPreview()
    const envelope = (sequence: number, event: WorkbenchEventEnvelope['event'], identity: WorkbenchEventEnvelope['identity'] = {}) => createWorkbenchEnvelope({
      sessionId: 'preview-session', recordedAt: `2026-08-25T00:00:0${sequence}.000Z`, sequence,
      source: { provider: 'acp', sourceId: `timeline-${sequence}` }, identity,
      provenance: { origin: 'local-observed', trust: 'authoritative' }, event,
    })
    const startedEvents = [
      envelope(1, { type: 'message.completed', role: 'user', parts: [{ kind: 'text', text: '读取文件' }] }, { messageId: 'user-1' }),
      envelope(2, { type: 'tool.started', tool: { name: 'Read', title: '读取文件' } }, { toolCallId: 'tool-between' }),
      envelope(4, { type: 'message.delta', role: 'assistant', parts: [{ kind: 'text', text: '读取完成' }] }, { messageId: 'assistant-1' }),
      envelope(5, { type: 'message.completed', role: 'assistant', parts: [] }, { messageId: 'assistant-1' }),
    ]
    // A late terminal event arrives after the assistant row. It updates the
    // existing card in place and must not move it below that reply.
    const completion = envelope(6, { type: 'tool.completed', tool: { status: 'completed', parts: [{ kind: 'text', text: '文件内容' }] } }, { toolCallId: 'tool-between' })
    const started = projectWorkbench(startedEvents).document
    const userId = started.messages.find(message => message.role === 'user')!.id
    const assistantId = started.messages.find(message => message.role === 'assistant')!.id

    services.runtime.replaceDocument(started, { ownerKey: 'owner-preview', generation: 1 })

    const user = await waitFor(() => host.querySelector<HTMLElement>(`[data-message-id="${userId}"]`)!)
    const tool = host.querySelector<HTMLElement>('[data-activity-id="tool-between"]')!
    const assistant = host.querySelector<HTMLElement>(`[data-message-id="${assistantId}"]`)!
    expect(tool).not.toBeNull()
    expect(assistant).not.toBeNull()
    expect(user.compareDocumentPosition(tool) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(tool.compareDocumentPosition(assistant) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(host.querySelectorAll('[data-activity-id="tool-between"]')).toHaveLength(1)

    services.runtime.replaceDocument(projectWorkbench([...startedEvents, completion]).document, {
      ownerKey: 'owner-preview', generation: 1,
    })
    await waitFor(() => expect(screen.getByRole('status', { name: '工具：读取文件，已完成' })).toBeTruthy())
    expect(host.querySelector('[data-activity-id="tool-between"]')).toBe(tool)
    expect(tool.compareDocumentPosition(assistant) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(host.querySelectorAll('[data-activity-id="tool-between"]')).toHaveLength(1)
  })

  it('工具聚合行复用普通工具卡结构，并跟随组内最后一次调用的状态色', async () => {
    const { host, services } = mountPreview()
    const envelope = (sequence: number, event: WorkbenchEventEnvelope['event'], toolCallId: string) => createWorkbenchEnvelope({
      sessionId: 'preview-session', recordedAt: `2026-08-25T00:00:0${sequence}.000Z`, sequence,
      source: { provider: 'peri', sourceId: `group-${sequence}` }, identity: { toolCallId },
      provenance: { origin: 'local-observed', trust: 'authoritative' }, event,
    })
    const document = projectWorkbench([
      envelope(1, { type: 'tool.started', tool: { name: 'Read', title: '读取文件' } }, 'group-tool-1'),
      envelope(2, { type: 'tool.completed', tool: { name: 'Read', title: '读取文件', status: 'completed' } }, 'group-tool-1'),
      envelope(3, { type: 'tool.started', tool: { name: 'Read', title: '读取文件' } }, 'group-tool-2'),
      envelope(4, { type: 'tool.failed', tool: { name: 'Read', title: '读取文件', status: 'failed' } }, 'group-tool-2'),
    ]).document
    services.runtime.replaceDocument(document, { ownerKey: 'owner-preview', generation: 1 })

    const group = await waitFor(() => {
      const value = host.querySelector<HTMLElement>('.solid-workbench-activity-group')
      expect(value).not.toBeNull()
      return value!
    })
    expect(group).toHaveClass('term-tool')
    expect(group).toHaveAttribute('data-count', '2')
    expect(group).toHaveAttribute('data-status', 'err')
    expect(group).toHaveAttribute('data-last-tool-status', 'failed')
    expect(group.querySelector('.term-tool-head')).not.toBeNull()
    expect(group.querySelector('.term-tool-indicator')).toHaveClass('err')
    expect(group.querySelector('.term-tool-name')).toHaveTextContent('读取文件')
    expect(group.querySelector('.term-tool-head')).toHaveAttribute('aria-expanded', 'false')

    fireEvent.click(group.querySelector<HTMLButtonElement>('.term-tool-head')!)
    expect(group.querySelectorAll('.solid-workbench-activity-slot')).toHaveLength(2)
  })

  it('让输入字号继承聊天字号，并保持助手正文与圆点处于同一布局行', async () => {
    const { host, services } = mountPreview()
    const theme = structuredClone(DEFAULTS)
    theme.assistantDot = true
    services.appearance.setTheme(theme)
    const workbench = host.querySelector<HTMLElement>('.solid-agent-workbench')!
    const assistant = await waitFor(() => {
      const value = host.querySelector<HTMLElement>('.term-assistant.has-dot')
      expect(value).not.toBeNull()
      return value!
    })

    expect(workbench.style.getPropertyValue('--input-font-size')).toBe('var(--chat-font-size)')
    expect(assistant.querySelector(':scope > .term-assistant-dot, :scope > .term-assistant-dot-img')).not.toBeNull()
    expect(assistant.querySelector(':scope > .term-assistant-body')).not.toBeNull()
  })

  it('消费会话搜索状态，高亮并定位当前匹配消息', async () => {
    const scrollIntoView = vi.fn()
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    })
    const { host, services } = mountPreview()

    services.sessionUi.set('preview-session', 'search-query', 'runtime 保持')
    services.sessionUi.set('preview-session', 'search-index', -7)

    await waitFor(() => expect(
      host.querySelector('[data-message-id="fixture-assistant-markdown"] .term-row-search-active'),
    ).not.toBeNull())
    expect(services.sessionUi.get('preview-session', 'search-index', -1)).toBe(0)
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center' })
  })

  it('用户离开底部后不抢滚动，并可一键恢复自动跟随', async () => {
    const scrollIntoView = vi.fn()
    const scrollTo = vi.fn()
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    })
    const { host, services } = mountPreview()
    const viewport = host.querySelector('.solid-workbench-chat') as HTMLDivElement
    Object.defineProperties(viewport, {
      scrollTop: { value: 100, writable: true, configurable: true },
      scrollHeight: { value: 1_000, configurable: true },
      clientHeight: { value: 300, configurable: true },
      scrollTo: { value: scrollTo, configurable: true },
    })

    fireEvent.scroll(viewport)
    expect(await screen.findByRole('button', { name: '回到底部' })).toBeTruthy()
    scrollIntoView.mockClear()

    services.runtime.update({ streamingText: '用户上滚后的新输出' })
    await Promise.resolve()
    expect(scrollIntoView).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: '回到底部' }))
    expect(scrollTo).toHaveBeenCalledWith({ top: 700, behavior: 'auto' })
    // The rail action remains available as an explicit endpoint control after
    // follow mode is restored; subsequent output should auto-follow again.
    expect(screen.getByRole('button', { name: '回到底部' })).toBeTruthy()

    scrollIntoView.mockClear()
    scrollTo.mockClear()
    services.runtime.update({ streamingText: '恢复跟随后继续输出' })
    await waitFor(() => expect(scrollTo).toHaveBeenCalledWith({ top: 700, behavior: 'auto' }))
  })

  it('流式正文异步改变高度时，sticky 状态继续跟随底部', async () => {
    const previousResizeObserver = globalThis.ResizeObserver
    class MockResizeObserver {
      static instances: MockResizeObserver[] = []
      readonly observed = new Set<Element>()
      constructor(private readonly callback: ResizeObserverCallback) { MockResizeObserver.instances.push(this) }
      observe(element: Element) { this.observed.add(element) }
      unobserve(element: Element) { this.observed.delete(element) }
      disconnect() { this.observed.clear() }
      trigger() { this.callback([], this as unknown as ResizeObserver) }
    }
    globalThis.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver
    try {
      const scrollTo = vi.fn()
      const { host, services } = mountPreview()
      const viewport = host.querySelector('.solid-workbench-chat') as HTMLDivElement
      Object.defineProperties(viewport, {
        scrollTop: { value: 700, writable: true, configurable: true },
        scrollHeight: { value: 1_000, configurable: true },
        clientHeight: { value: 300, configurable: true },
        scrollTo: { value: scrollTo, configurable: true },
      })
      await Promise.resolve()
      scrollTo.mockClear()

      const contentObserver = MockResizeObserver.instances.find(observer => observer.observed.has(host.querySelector('.term')!))
      expect(contentObserver).toBeTruthy()
      // The resize signal represents a real async height change (for example
      // a newly measured Markdown/image block), so the bottom endpoint moves.
      Object.defineProperty(viewport, 'scrollHeight', { value: 1_100, configurable: true })
      contentObserver!.trigger()
      await waitFor(() => expect(scrollTo).toHaveBeenCalledWith({ top: 800, behavior: 'auto' }))
      scrollTo.mockClear()
      // Repeated observer notifications at the same endpoint must not issue a
      // second scroll write; this is the jitter regression guard.
      contentObserver!.trigger()
      await Promise.resolve()
      expect(scrollTo).not.toHaveBeenCalled()
      services.runtime.destroy()
    } finally {
      globalThis.ResizeObserver = previousResizeObserver
    }
  })

  it('同一帧 outer follow 合并多次 ResizeObserver 通知，且离底取消排队写入', async () => {
    const previousRaf = globalThis.requestAnimationFrame
    const previousCancel = globalThis.cancelAnimationFrame
    let nextFrame = 0
    const frames = new Map<number, FrameRequestCallback>()
    globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
      const id = ++nextFrame
      frames.set(id, callback)
      return id
    }) as typeof requestAnimationFrame
    globalThis.cancelAnimationFrame = ((id: number) => { frames.delete(id) }) as typeof cancelAnimationFrame
    const previousResizeObserver = globalThis.ResizeObserver
    class MockResizeObserver {
      static instances: MockResizeObserver[] = []
      readonly observed = new Set<Element>()
      constructor(private readonly callback: ResizeObserverCallback) { MockResizeObserver.instances.push(this) }
      observe(element: Element) { this.observed.add(element) }
      unobserve(element: Element) { this.observed.delete(element) }
      disconnect() { this.observed.clear() }
      trigger() { this.callback([], this as unknown as ResizeObserver) }
    }
    globalThis.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver
    const flushFrame = () => {
      const pending = [...frames.values()]
      frames.clear()
      for (const callback of pending) callback(performance.now())
    }
    try {
      const scrollTo = vi.fn()
      const { host, services } = mountPreview()
      const viewport = host.querySelector('.solid-workbench-chat') as HTMLDivElement
      Object.defineProperties(viewport, {
        scrollTop: { value: 700, writable: true, configurable: true },
        scrollHeight: { value: 1_000, configurable: true },
        clientHeight: { value: 300, configurable: true },
        scrollTo: { value: scrollTo, configurable: true },
      })
      await Promise.resolve()
      flushFrame()
      scrollTo.mockClear()

      const contentObserver = MockResizeObserver.instances.find(observer => observer.observed.has(host.querySelector('.term')!))
      expect(contentObserver).toBeTruthy()
      Object.defineProperty(viewport, 'scrollHeight', { value: 1_100, configurable: true })
      // Drop mount/connector work; the assertions below measure only this
      // content observer's same-frame follow request.
      frames.clear()
      contentObserver!.trigger()
      contentObserver!.trigger()
      contentObserver!.trigger()
      expect(scrollTo).not.toHaveBeenCalled()
      expect(frames.size).toBe(1)
      flushFrame()
      expect(scrollTo).toHaveBeenCalledTimes(1)
      expect(scrollTo).toHaveBeenLastCalledWith({ top: 800, behavior: 'auto' })

      // A user scroll invalidates the queued action before its frame runs.
      Object.defineProperty(viewport, 'scrollTop', { value: 100, writable: true, configurable: true })
      Object.defineProperty(viewport, 'scrollHeight', { value: 1_200, configurable: true })
      contentObserver!.trigger()
      fireEvent.scroll(viewport)
      flushFrame()
      expect(scrollTo).toHaveBeenCalledTimes(1)
      services.runtime.destroy()
    } finally {
      globalThis.requestAnimationFrame = previousRaf
      globalThis.cancelAnimationFrame = previousCancel
      globalThis.ResizeObserver = previousResizeObserver
    }
  })

  it('右栏与 Solid 对 canonical semantic parts 使用同一搜索文本口径', async () => {
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn(),
    })
    const { host, services } = mountPreview()
    const current = services.runtime.getSnapshot().document!
    const target = current.messages.find(message => message.id === 'fixture-assistant-markdown')!
    services.runtime.replaceDocument({
      ...current,
      messages: [{ ...target, content: '', parts: [{ kind: 'text', text: 'canonical semantic needle' }] }],
    }, { ownerKey: 'owner-preview', generation: 1 })

    services.sessionUi.set('preview-session', 'search-query', 'semantic needle')

    await waitFor(() => expect(
      host.querySelector('[data-message-id="fixture-assistant-markdown"] .term-row-search-active'),
    ).not.toBeNull())
  })

  it('把同一助手消息的流式文本 parts 渲染为一个连续 Markdown 块', async () => {
    const { host, services } = mountPreview()
    const chunk = (sequence: number, text: string) => createWorkbenchEnvelope({
      sessionId: 'preview-session', sequence,
      recordedAt: `2026-08-25T00:00:0${sequence}.000Z`,
      source: { provider: 'peri', sourceId: `assistant-chunk-${sequence}` },
      identity: { messageId: `rotated-chunk-${sequence}` },
      provenance: { origin: 'local-observed', trust: 'authoritative' },
      event: { type: 'message.delta', role: 'assistant', parts: [{ kind: 'text', text }] },
    })
    const projected = projectWorkbench([
      chunk(1, '这是'), chunk(2, '完整的'), chunk(3, '助手'), chunk(4, '回复。'),
    ]).document
    services.runtime.replaceDocument(projected, { ownerKey: 'owner-preview', generation: 1 })

    const body = await waitFor(() => {
      const element = host.querySelector(`[data-message-id="${projected.messages[0]!.id}"] .term-assistant-body`)
      expect(element).not.toBeNull()
      return element as HTMLElement
    })
    expect(body).toHaveTextContent('这是完整的助手回复。')
    expect(body.querySelectorAll('p')).toHaveLength(1)
  })

  it('同一 provider message id 跨工具形成独立且重放稳定的助手 DOM 行', async () => {
    const { host, services } = mountPreview()
    const make = (sequence: number, event: WorkbenchEventEnvelope['event'], identity: WorkbenchEventEnvelope['identity']) => createWorkbenchEnvelope({
      sessionId: 'preview-session', sequence,
      recordedAt: `2026-08-25T00:00:0${sequence}.000Z`,
      source: { provider: 'peri', sourceId: `segment-${sequence}` }, identity,
      provenance: { origin: 'local-observed', trust: 'authoritative' }, event,
    })
    const projected = projectWorkbench([
      make(1, { type: 'message.delta', role: 'assistant', parts: [{ kind: 'text', text: '工具前回复' }] }, { messageId: 'shared-provider-id' }),
      make(2, { type: 'tool.started', tool: { name: 'Read', title: '读取' } }, { toolCallId: 'tool-between-segments' }),
      make(3, { type: 'message.delta', role: 'assistant', parts: [{ kind: 'text', text: '工具后回复' }] }, { messageId: 'shared-provider-id' }),
    ]).document

    expect(new Set(projected.messages.map(message => message.id)).size).toBe(2)
    for (let iteration = 0; iteration < 20; iteration += 1) {
      services.runtime.replaceDocument(structuredClone(projected), { ownerKey: 'owner-preview', generation: iteration + 1 })
    }

    await waitFor(() => expect(host.querySelectorAll('.plain-message-list__row')).toHaveLength(2))
    const rows = [...host.querySelectorAll<HTMLElement>('.plain-message-list__row')]
    expect(rows.map(row => row.textContent)).toEqual(expect.arrayContaining([
      expect.stringContaining('工具前回复'),
      expect.stringContaining('工具后回复'),
    ]))
    expect(host.querySelectorAll('[data-activity-id="tool-between-segments"]')).toHaveLength(1)
  })

  it('canonical assistant chunk updates reuse one content Slot and propagate streaming state', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    hosts.push(host)
    const services = createPreviewWorkbenchServices()
    servicesList.push(services)
    let destroys = 0
    const mountedNodeIds: string[] = []
    const updates: Array<{ text: string; streaming?: boolean }> = []
    let canonicalNodeId: string | undefined
    const slot: RendererSlotContribution = {
      id: 'test.streaming-markdown', targetSuites: ['builtin.solid'], kinds: ['content.markdown'],
      priority: 10, fallback: false, canRender: () => true,
      createSurface: () => ({
        rendererId: 'test.streaming-markdown', kind: 'solid',
        mount(container, snapshot) {
          const payload = snapshot.payload as { text?: string }
          if (!canonicalNodeId && payload.text?.startsWith('# 标题')) canonicalNodeId = snapshot.nodeId
          const target = snapshot.nodeId === canonicalNodeId
          if (target) mountedNodeIds.push(snapshot.nodeId)
          const node = document.createElement('p')
          container.append(node)
          const apply = (value: typeof snapshot) => {
            const payload = value.payload as { text?: string }
            node.textContent = payload.text ?? ''
            if (target) updates.push({ text: payload.text ?? '', streaming: (value as typeof value & { streaming?: boolean }).streaming })
          }
          apply(snapshot)
          return { node, apply, target }
        },
        update(handle, snapshot) { (handle as { apply(value: typeof snapshot): void }).apply(snapshot) },
        destroy(handle) {
          if ((handle as { target: boolean }).target) destroys += 1
          ;(handle as { node: HTMLElement }).node.remove()
        },
        on: () => () => {},
      }),
    }
    const entry = {
      ownerPluginId: 'test.streaming-markdown', ownerRuntimeInstanceId: 'runtime', contributionId: slot.id,
      layer: 'feature', priority: slot.priority, value: slot,
    } as RegistryEntry<RendererSlotContribution>
    const suite = { id: 'builtin.solid' } as RendererSuiteContribution
    const activation = {
      revision: 1,
      suite: { ownerPluginId: 'builtin.pylon-renderers', ownerRuntimeInstanceId: 'runtime', contributionId: suite.id, layer: 'feature', priority: 1, value: suite },
      kinds: new Map(), slots: new Map([['content.markdown', [entry]]]), diagnostics: [],
    } as RendererActivationSnapshot
    mountSolidWorkbench({ host, input: { sheetId: 'sheet-a', sessionId: 'preview-session' }, services, activation })

    const events: WorkbenchEventEnvelope[] = []
    const chunk = (sequence: number, text: string, type: 'message.delta' | 'message.completed' = 'message.delta') => createWorkbenchEnvelope({
      sessionId: 'preview-session', sequence, recordedAt: `2026-08-25T00:00:${String(sequence).padStart(2, '0')}.000Z`,
      source: { provider: 'peri', sourceId: `canonical-stream-${sequence}` }, identity: { messageId: `canonical-stream-${sequence}` },
      provenance: { origin: 'local-observed', trust: 'authoritative' },
      event: { type, role: 'assistant', parts: [{ kind: 'markdown', text }] },
    })
    for (let sequence = 1; sequence <= 20; sequence += 1) {
      events.push(chunk(sequence, sequence === 1 ? '# 标题\n\n' : `片段${sequence} `))
      services.runtime.replaceDocument(projectWorkbench(events).document, { ownerKey: 'owner-preview', generation: sequence })
    }

    await waitFor(() => expect(updates.at(-1)?.text).toContain('片段20'))
    expect(updates.at(-1)?.streaming).toBe(true)

    events.push(chunk(21, '', 'message.completed'))
    services.runtime.replaceDocument(projectWorkbench(events).document, { ownerKey: 'owner-preview', generation: 21 })
    await waitFor(() => expect(updates.at(-1)?.streaming).toBeUndefined())

    expect(mountedNodeIds).toEqual([canonicalNodeId])
    expect(destroys).toBe(0)
    const canonicalMessageId = projectWorkbench(events).document.messages[0]!.id
    expect(host.querySelectorAll(`[data-message-id="${canonicalMessageId}"]`)).toHaveLength(1)
  })

  it('诊断：诗歌流式旁路切到 canonical 后保留段落结构', async () => {
    const { host, services } = mountPreview()
    const poem = '**星河**\n\n春风拂过山岗\n月光落在窗\n\n我把远方写进诗行\n让星河在梦里流淌'
    services.runtime.replaceDocument(createWorkbenchDocument('preview-session'), {
      ownerKey: 'owner-preview', generation: 1, sessionId: 'preview-session',
    })
    services.runtime.update({ streamingText: poem, generating: true })
    const streamingBody = await waitFor(() => {
      const body = host.querySelector('.term-row-assistant .term-assistant-body')
      expect(body).not.toBeNull()
      return body as HTMLElement
    })
    const streamingMarkup = streamingBody.innerHTML

    const events = [
      createWorkbenchEnvelope({
        sessionId: 'preview-session', sequence: 1,
        recordedAt: '2026-08-25T00:00:01.000Z',
        source: { provider: 'peri', sourceId: 'poem-delta' },
        identity: { messageId: 'poem-message' },
        provenance: { origin: 'local-observed', trust: 'authoritative' },
        event: { type: 'message.delta', role: 'assistant', parts: [{ kind: 'markdown', text: poem }] },
      }),
      createWorkbenchEnvelope({
        sessionId: 'preview-session', sequence: 2,
        recordedAt: '2026-08-25T00:00:02.000Z',
        source: { provider: 'peri', sourceId: 'poem-complete' },
        identity: { messageId: 'poem-message' },
        provenance: { origin: 'local-observed', trust: 'authoritative' },
        event: { type: 'message.completed', role: 'assistant', parts: [] },
      }),
    ]
    const finalDocument = projectWorkbench(events).document
    services.runtime.replaceDocument(finalDocument, {
      ownerKey: 'owner-preview', generation: 2, sessionId: 'preview-session',
    })
    services.runtime.update({ streamingText: '', generating: false })

    const finalBody = await waitFor(() => {
      const body = host.querySelector(`[data-message-id="${finalDocument.messages[0]!.id}"] .term-assistant-body`)
      expect(body).not.toBeNull()
      return body as HTMLElement
    })
    await waitFor(() => expect(finalBody.querySelector('strong')).not.toBeNull())
    // Keep this seam explicit: the final renderer must expose all three blocks
    // and preserve the soft line break inside each verse.
    expect(streamingMarkup).toContain('春风拂过山岗')
    expect(finalBody.textContent).toContain('春风拂过山岗\n月光落在窗')
    expect(finalBody.querySelectorAll('p')).toHaveLength(3)
  })

  it('canonical 思考流与 legacy streamingThinking 不重复渲染', async () => {
    const { host, services } = mountPreview()
    const reasoning = createWorkbenchEnvelope({
      sessionId: 'preview-session', sequence: 1,
      recordedAt: '2026-08-25T00:00:01.000Z',
      source: { provider: 'peri', sourceId: 'thinking-stream' },
      identity: { turnId: 'thinking-turn' },
      provenance: { origin: 'local-observed', trust: 'authoritative' },
      event: { type: 'reasoning.delta', parts: [{ kind: 'text', text: '同一段思考' }] },
    })
    const document = projectWorkbench([reasoning]).document
    services.runtime.replaceDocument(document, { ownerKey: 'owner-preview', generation: 1 })
    services.runtime.update({ streamingThinking: '同一段思考', generating: true })

    await waitFor(() => expect(host.querySelectorAll('.term-row-reasoning')).toHaveLength(1))
    expect(host.querySelectorAll('.term-reasoning')).toHaveLength(1)
  })

  it('canonical 终态短暂清除 running 时仍抑制重复 transient 思考行', async () => {
    const { host, services } = mountPreview()
    const reasoning = createWorkbenchEnvelope({
      sessionId: 'preview-session', sequence: 1,
      recordedAt: '2026-08-25T00:00:01.000Z',
      source: { provider: 'peri', sourceId: 'thinking-terminal' },
      identity: { turnId: 'thinking-terminal-turn' },
      provenance: { origin: 'local-observed', trust: 'authoritative' },
      event: { type: 'reasoning.completed', parts: [{ kind: 'text', text: '终态思考' }] },
    })
    services.runtime.replaceDocument(projectWorkbench([reasoning]).document, { ownerKey: 'owner-preview', generation: 1 })
    services.runtime.update({ streamingThinking: '终态思考', generating: true })

    await waitFor(() => expect(host.querySelectorAll('.term-row-reasoning')).toHaveLength(1))
    expect(host.querySelectorAll('.term-reasoning')).toHaveLength(1)
  })

  it('legacy 工具行接管消息列表时仍保留 canonical/legacy 思考流可见性', async () => {
    const { host, services } = mountPreview()
    const reasoning = createWorkbenchEnvelope({
      sessionId: 'preview-session', sequence: 1,
      recordedAt: '2026-08-25T00:00:01.000Z',
      source: { provider: 'peri', sourceId: 'thinking-with-tool' },
      identity: { turnId: 'thinking-with-tool-turn' },
      provenance: { origin: 'local-observed', trust: 'authoritative' },
      event: { type: 'reasoning.delta', parts: [{ kind: 'text', text: '工具旁的思考' }] },
    })
    const canonical = projectWorkbench([reasoning]).document
    const legacyTool = {
      id: 'legacy-tool-row', role: 'tool' as const, sender: 'peri', content: '', time: 't',
      toolName: 'Read', toolStatus: 'running', running: true,
    }
    services.runtime.update({
      document: canonical,
      messages: [legacyTool],
      streamingThinking: '工具旁的思考',
      generating: true,
    })

    await waitFor(() => expect(host.querySelectorAll('.term-row-reasoning')).toHaveLength(1))
    expect(host).toHaveTextContent('工具旁的思考')
  })

  it('canonical reasoning updates keep one expanded Slot live until completion', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    hosts.push(host)
    const services = createPreviewWorkbenchServices()
    servicesList.push(services)
    const slot = createBuiltinSolidContentSlot()
    const slotEntry = {
      ownerPluginId: 'builtin.pylon-renderers', ownerRuntimeInstanceId: 'runtime',
      contributionId: slot.id, layer: 'feature', priority: slot.priority, value: slot,
    } as RegistryEntry<RendererSlotContribution>
    const suite = { id: 'builtin.solid' } as RendererSuiteContribution
    const activation = {
      revision: 1,
      suite: { ownerPluginId: 'builtin.pylon-renderers', ownerRuntimeInstanceId: 'runtime', contributionId: suite.id, layer: 'feature', priority: 1, value: suite },
      kinds: new Map(), slots: new Map([['content.reasoning', [slotEntry]]]), diagnostics: [],
    } as RendererActivationSnapshot
    mountSolidWorkbench({ host, input: { sheetId: 'sheet-a', sessionId: 'preview-session' }, services, activation })

    const envelope = (sequence: number, text: string, type: 'reasoning.delta' | 'reasoning.completed' = 'reasoning.delta') => createWorkbenchEnvelope({
      sessionId: 'preview-session', sequence, recordedAt: `2026-08-25T00:00:0${sequence}.000Z`,
      source: { provider: 'peri', sourceId: `reasoning-${sequence}` }, identity: { messageId: 'reasoning-stream' },
      provenance: { origin: 'local-observed', trust: 'authoritative' },
      event: { type, parts: text ? [{ kind: 'markdown', text }] : [] },
    })
    const events = [envelope(1, '1. 我应该先检查')]
    services.runtime.replaceDocument(projectWorkbench(events).document, { ownerKey: 'owner-preview', generation: 1 })

    const canonicalMessageId = projectWorkbench(events).document.messages[0]!.id
    const button = await waitFor(() => {
      const node = host.querySelector<HTMLButtonElement>(`[data-message-id="${canonicalMessageId}"] .term-reasoning-head`)
      expect(node).not.toBeNull()
      return node!
    })
    expect(button).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(button)
    const reasoning = host.querySelector('.term-reasoning')
    expect(reasoning).not.toBeNull()

    events.push(envelope(2, '，然后继续验证。'))
    services.runtime.replaceDocument(projectWorkbench(events).document, { ownerKey: 'owner-preview', generation: 2 })
    await waitFor(() => expect(reasoning).toHaveTextContent('我应该先检查，然后继续验证。'))
    expect(reasoning?.querySelector('ol > li')).toHaveTextContent('我应该先检查，然后继续验证。')
    expect(host.querySelector('.term-reasoning')).toBe(reasoning)
    expect(button).toHaveAttribute('aria-expanded', 'true')

    events.push(envelope(3, '', 'reasoning.completed'))
    services.runtime.replaceDocument(projectWorkbench(events).document, { ownerKey: 'owner-preview', generation: 3 })
    await waitFor(() => expect(reasoning).toHaveAttribute('data-state', 'complete'))
    expect(button).toHaveAttribute('aria-expanded', 'true')
    expect(host.querySelector('.term-reasoning')).toBe(reasoning)
  })

  it('反复替换同一会话文档时不累积助手回复 DOM', async () => {
    const { host, services } = mountPreview()
    const chunk = (sequence: number, text: string) => createWorkbenchEnvelope({
      sessionId: 'preview-session', sequence,
      recordedAt: `2026-08-25T00:00:0${sequence}.000Z`,
      source: { provider: 'peri', sourceId: `repeat-chunk-${sequence}` },
      identity: { messageId: `repeat-chunk-${sequence}` },
      provenance: { origin: 'local-observed', trust: 'authoritative' },
      event: { type: 'message.delta', role: 'assistant', parts: [{ kind: 'text', text }] },
    })
    const document = projectWorkbench([chunk(1, '不会'), chunk(2, '重复')]).document
    const messageId = document.messages[0]!.id

    for (let iteration = 0; iteration < 100; iteration += 1) {
      services.runtime.replaceDocument(structuredClone(document), { ownerKey: 'owner-preview', generation: iteration + 1 })
    }

    await waitFor(() => expect(host.querySelectorAll(`[data-message-id="${messageId}"]`)).toHaveLength(1))
    const rows = host.querySelectorAll(`[data-message-id="${messageId}"]`)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toHaveTextContent('不会重复')
    expect(rows[0]!.querySelectorAll('.term-assistant-body p')).toHaveLength(1)
  })

  it('切换会话时即使 message id 相同也只保留当前会话的一行', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    hosts.push(host)
    const services = createPreviewWorkbenchServices()
    servicesList.push(services)
    const slot = createBuiltinSolidContentSlot()
    const slotEntry = {
      ownerPluginId: 'builtin.pylon-renderers', ownerRuntimeInstanceId: 'runtime',
      contributionId: slot.id, layer: 'feature', priority: slot.priority, value: slot,
    } as RegistryEntry<RendererSlotContribution>
    const suite = { id: 'builtin.solid' } as RendererSuiteContribution
    const activation = {
      revision: 1,
      suite: { ownerPluginId: 'builtin.pylon-renderers', ownerRuntimeInstanceId: 'runtime', contributionId: suite.id, layer: 'feature', priority: 1, value: suite },
      kinds: new Map(), slots: new Map([['content.markdown', [slotEntry]]]), diagnostics: [],
    } as RendererActivationSnapshot
    const lifecycle = mountSolidWorkbench({
      host, input: { sheetId: 'sheet-a', sessionId: 'preview-session', preview: true }, services, activation,
    })
    const documentFor = (sessionId: string, text: string) => projectWorkbench([
      createWorkbenchEnvelope({
        sessionId, sequence: 1,
        recordedAt: `2026-08-25T00:00:0${sessionId === 'session-a' ? '1' : '2'}.000Z`,
        source: { provider: 'peri', sourceId: `${sessionId}-tool` },
        identity: { toolCallId: 'same-tool-id' },
        provenance: { origin: 'local-observed', trust: 'authoritative' },
        event: { type: 'tool.started', tool: { name: `Read ${text}` } },
      }),
      createWorkbenchEnvelope({
        sessionId, sequence: 2,
        recordedAt: `2026-08-25T00:00:0${sessionId === 'session-a' ? '1' : '2'}.500Z`,
        source: { provider: 'peri', sourceId: `${sessionId}-source` },
        identity: { messageId: 'same-message-id' },
        provenance: { origin: 'local-observed', trust: 'authoritative' },
        event: { type: 'message.delta', role: 'assistant', parts: [{ kind: 'markdown', text }] },
      }),
    ]).document

    const sessionADocument = documentFor('session-a', '会话 A')
    const sessionBDocument = documentFor('session-b', '会话 B')
    const sessionAMessageId = sessionADocument.messages[0]!.id
    services.runtime.replaceDocument(sessionADocument, {
      ownerKey: 'owner-a', generation: 1, sessionId: 'session-a',
    })
    lifecycle.update({ sheetId: 'sheet-a', sessionId: 'session-a', preview: true })
    const firstRow = await waitFor(() => {
      const row = host.querySelector(`[data-message-id="${sessionAMessageId}"]`)
      expect(row?.querySelector('[data-renderer-slot-id="builtin.solid.content.base"]')).toHaveTextContent('会话 A')
      if (!row) throw new Error('session A production Slot row not mounted')
      return row
    })
    const firstSlot = firstRow.querySelector('[data-renderer-slot-id="builtin.solid.content.base"]')
    const firstTool = host.querySelector('[data-activity-id="same-tool-id"]')
    expect(firstTool).not.toBeNull()

    for (let iteration = 0; iteration < 100; iteration += 1) {
      services.runtime.replaceDocument(sessionBDocument, {
        ownerKey: 'owner-b', generation: iteration + 1, sessionId: 'session-b',
      })
      lifecycle.update({ sheetId: 'sheet-a', sessionId: 'session-b', preview: true })
      services.runtime.replaceDocument(sessionADocument, {
        ownerKey: 'owner-a', generation: iteration + 2, sessionId: 'session-a',
      })
      lifecycle.update({ sheetId: 'sheet-a', sessionId: 'session-a', preview: true })
    }

    await waitFor(() => expect(host.querySelector(`[data-message-id="${sessionAMessageId}"]`)).toHaveTextContent('会话 A'))
    expect(host.querySelectorAll(`[data-message-id="${sessionAMessageId}"]`)).toHaveLength(1)
    expect(host.querySelectorAll('[data-renderer-slot-id="builtin.solid.content.base"]')).toHaveLength(1)
    expect(host.querySelector(`[data-message-id="${sessionAMessageId}"]`)).not.toBe(firstRow)
    expect(host.querySelector('[data-renderer-slot-id="builtin.solid.content.base"]')).not.toBe(firstSlot)
    expect(host.querySelectorAll('[data-activity-id="same-tool-id"]')).toHaveLength(1)
    expect(host.querySelector('[data-activity-id="same-tool-id"]')).not.toBe(firstTool)
    expect(host).not.toHaveTextContent('会话 B')
  })

  it('合并流式文本时保留非文本 semantic part 的渲染边界', async () => {
    const { host, services } = mountPreview()
    const projected = projectWorkbench([createWorkbenchEnvelope({
      sessionId: 'preview-session', sequence: 1,
      recordedAt: '2026-08-25T00:00:01.000Z',
      source: { provider: 'peri', sourceId: 'mixed-content' },
      identity: { messageId: 'mixed-content' },
      provenance: { origin: 'local-observed', trust: 'authoritative' },
      event: { type: 'message.delta', role: 'assistant', parts: [
        { kind: 'text', text: '前半' },
        { kind: 'text', text: '正文' },
        { kind: 'code', text: 'const answer = 42', language: 'ts' },
        { kind: 'markdown', text: '后半' },
        { kind: 'text', text: '正文' },
      ] },
    })]).document
    services.runtime.replaceDocument(projected, { ownerKey: 'owner-preview', generation: 1 })

    const body = await waitFor(() => {
      const element = host.querySelector(`[data-message-id="${projected.messages[0]!.id}"] .term-assistant-body`)
      expect(element).not.toBeNull()
      return element as HTMLElement
    })
    expect(body.querySelectorAll('p')).toHaveLength(2)
    expect(body.querySelector('.term-code-block')).not.toBeNull()
    expect(body.textContent).toContain('前半正文')
    expect(body.textContent).toContain('后半正文')
  })

  it('挂载完整 fixture shell，复用 Message/Tool/Task/Generation renderer', async () => {
    const { host } = mountPreview()

    expect(screen.getByLabelText('Solid Agent Workbench')).toBeTruthy()
    expect(host.querySelector('[data-renderer="solid"]')?.getAttribute('data-preview')).toBe('true')
    expect(await screen.findByRole('heading', { name: '迁移结果' }, { timeout: 5_000 })).toBeTruthy()
    expect(screen.getByText('Read')).toBeTruthy()
    expect(host.querySelector('.task-tree')).toBeTruthy()
    expect(host.querySelector('.term-spinner')).toBeTruthy()
    expect(host.querySelector('.control-center')?.getAttribute('data-control-center')).toBe('production')
    expect(host.querySelector('.pet-companion')?.getAttribute('data-fixture')).toBe('pending')
    await waitFor(() => expect(host.querySelectorAll('.plain-message-list__row').length).toBeGreaterThan(0))
  })

  it('中控状态分隔符只出现在实际可见控件之间，不产生前导中点', async () => {
    const { host } = mountPreview()
    const row = await waitFor(() => {
      const value = host.querySelector<HTMLElement>('.cc-status-row')
      expect(value).not.toBeNull()
      return value!
    })
    const widgets = [...row.querySelectorAll('[data-widget-id]')]
    const separators = [...row.querySelectorAll<HTMLElement>('.cc-widget-separator')]
    expect(widgets.length).toBeGreaterThan(0)
    expect(separators).toHaveLength(widgets.length - 1)
    expect(row.querySelector('[data-separator-index="0"]')).toBeNull()
    expect(separators.map(item => item.dataset.separatorIndex)).toEqual(
      Array.from({ length: widgets.length - 1 }, (_, index) => String(index + 1)),
    )
  })

  it('update 不重挂 root，并切换 replay/Session 输入', async () => {
    const { host, lifecycle } = mountPreview()
    const root = host.firstElementChild

    lifecycle.update({
      sheetId: 'sheet-a',
      sessionId: 'preview-session',
      preview: true,
      replayReadonly: true,
      rightInset: 80,
    })

    await waitFor(() => expect(screen.getByText('历史回放 · 只读')).toBeTruthy())
    expect(host.firstElementChild).toBe(root)
    expect(host.querySelector('.control-center')).toBeNull()
    expect(host.firstElementChild?.getAttribute('style')).toContain('--right-panel-inset: 80px')

    lifecycle.update({
      sheetId: 'sheet-a', sessionId: null, preview: true, workspaceMode: 'work',
    })
    const emptyState = await screen.findByRole('region', { name: 'Agent 工作台空态' })
    expect(emptyState).toHaveAttribute('data-control-center', 'production')
    expect(screen.getByRole('img', { name: 'Pylon Agent' })).toBeTruthy()
    expect(screen.getByRole('combobox', { name: '新会话工作区' })).toBeDisabled()
    expect(screen.getByRole('textbox', { name: '消息输入' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '开始新会话' })).toBeNull()
    expect(screen.getByRole('button', { name: '添加附件' })).toBeTruthy()
    expect(screen.queryByLabelText('输入快捷键提示')).toBeNull()
    expect(host.querySelector('.control-center')).toBe(emptyState)
    expect(host.querySelectorAll('.input-textarea')).toHaveLength(1)
    lifecycle.update({ sheetId: 'sheet-a', sessionId: 'preview-session', preview: true, replayReadonly: false })
    await waitFor(() => expect(host.querySelector('.solid-workbench-chat-shell')).toBeTruthy())
    expect(host.querySelector('.control-center')).toBe(emptyState)
    expect(host.firstElementChild).toBe(root)
  })

  it('空态只有一个工作区时自动选中，并随首条请求创建会话', async () => {
    const { services, lifecycle } = mountPreview()
    lifecycle.update({
      sheetId: 'sheet-a', sessionId: null, preview: true, workspaceMode: 'work',
      availableWorkspaces: [{ id: 'workspace-a', label: 'Prism', path: 'G:/Project/prism' }],
    })

    const workspace = await screen.findByRole('combobox', { name: '新会话工作区' })
    expect(workspace).toHaveValue('workspace-a')
    const prompt = screen.getByRole('textbox', { name: '消息输入' })
    fireEvent.input(prompt, { target: { value: '检查当前项目' } })
    fireEvent.keyDown(prompt, { key: 'Enter', code: 'Enter', shiftKey: false })

    await waitFor(() => expect(services.commands.calls).toContainEqual({
      command: 'createSession',
      args: [{ workspaceId: 'workspace-a', initialPrompt: { text: '检查当前项目', attachments: [] }, mode: 'auto', model: 'deepseek-v4-flash', reasoningLevel: 'medium' }],
    }))
  })

  it('空态有多个工作区时按 host 提供的最近活跃时间预选', async () => {
    const { lifecycle } = mountPreview()
    lifecycle.update({
      sheetId: 'sheet-a', sessionId: null, preview: true, workspaceMode: 'work',
      availableWorkspaces: [
        { id: 'workspace-old', label: '旧项目', path: 'G:/old', lastActiveAt: 10 },
        { id: 'workspace-recent', label: '最近项目', path: 'G:/recent', lastActiveAt: 30 },
      ],
    })

    const workspace = await screen.findByRole('combobox', { name: '新会话工作区' })
    expect(workspace).toHaveValue('workspace-recent')

    lifecycle.update({
      sheetId: 'sheet-a', sessionId: null, preview: true, workspaceMode: 'work',
      availableWorkspaces: [
        { id: 'workspace-unknown-a', label: '未知 A', path: 'G:/unknown-a' },
        { id: 'workspace-unknown-b', label: '未知 B', path: 'G:/unknown-b' },
      ],
    })
    await waitFor(() => expect(workspace).toHaveValue(''))
  })

  it('Sidebar 创建会话事件先到达时缓存 workspaceId，不被空态初始化覆盖', async () => {
    const { lifecycle } = mountPreview()
    lifecycle.update({
      sheetId: 'sheet-a', sessionId: 'preview-session', preview: true, workspaceMode: 'work',
      availableWorkspaces: [
        { id: 'workspace-old', label: '旧项目', path: 'G:/old', lastActiveAt: 100 },
        { id: 'workspace-target', label: '目标项目', path: 'G:/target', lastActiveAt: 1 },
      ],
    })
    // Sidebar dispatches before clearing the selected session.
    window.dispatchEvent(new CustomEvent('pylon:new-session', { detail: { workspaceId: 'workspace-target' } }))
    lifecycle.update({
      sheetId: 'sheet-a', sessionId: null, preview: true, workspaceMode: 'work',
      availableWorkspaces: [
        { id: 'workspace-old', label: '旧项目', path: 'G:/old', lastActiveAt: 100 },
        { id: 'workspace-target', label: '目标项目', path: 'G:/target', lastActiveAt: 1 },
      ],
    })
    expect(await screen.findByRole('combobox', { name: '新会话工作区' })).toHaveValue('workspace-target')
  })

  it('手动选择工作区后，列表更新不会重新套用最近活跃项', async () => {
    const { lifecycle } = mountPreview()
    const options = [
      { id: 'workspace-a', label: 'A', path: 'G:/a', lastActiveAt: 10 },
      { id: 'workspace-b', label: 'B', path: 'G:/b', lastActiveAt: 20 },
    ]
    lifecycle.update({ sheetId: 'sheet-a', sessionId: null, preview: true, workspaceMode: 'work', availableWorkspaces: options })
    const workspace = await screen.findByRole('combobox', { name: '新会话工作区' })
    fireEvent.change(workspace, { target: { value: 'workspace-a' } })
    lifecycle.update({
      sheetId: 'sheet-a', sessionId: null, preview: true, workspaceMode: 'work',
      availableWorkspaces: [...options, { id: 'workspace-c', label: 'C', path: 'G:/c', lastActiveAt: 99 }],
    })
    await waitFor(() => expect(workspace).toHaveValue('workspace-a'))
  })

  it('空态不挂载 composer 快捷键提示，并在创建后标记进入过渡态', async () => {
    const { host, lifecycle } = mountPreview()
    lifecycle.update({ sheetId: 'sheet-a', sessionId: null, preview: true, workspaceMode: 'chat' })
    await screen.findByRole('region', { name: 'Agent 工作台空态' })
    expect(host.querySelector('.input-composer-meta')).toBeNull()
    lifecycle.update({ sheetId: 'sheet-a', sessionId: 'preview-session', preview: true, workspaceMode: 'chat' })
    await waitFor(() => expect(host.querySelector('.control-center')?.className).toContain('is-session-entering'))
  })

  it('空态创建期间冻结事务输入并暴露忙碌状态', async () => {
    let finishCreation: ((value: { sessionId: string }) => void) | undefined
    const { services, lifecycle } = mountPreview()
    services.commands.setHandler('createSession', vi.fn(() => new Promise<{ sessionId: string }>(resolve => { finishCreation = resolve })))
    lifecycle.update({
      sheetId: 'sheet-a', sessionId: null, preview: true, workspaceMode: 'work',
      availableWorkspaces: [{ id: 'workspace-a', label: 'Prism', path: 'G:/Project/prism' }],
    })
    const prompt = await screen.findByRole('textbox', { name: '消息输入' })
    fireEvent.input(prompt, { target: { value: '执行耗时任务' } })
    fireEvent.keyDown(prompt, { key: 'Enter', code: 'Enter', shiftKey: false })

    const emptyState = screen.getByRole('region', { name: 'Agent 工作台空态' })
    expect(emptyState).toHaveAttribute('aria-busy', 'true')
    expect(screen.getByRole('combobox', { name: '新会话工作区' })).toBeDisabled()
    expect(prompt).toBeDisabled()

    finishCreation?.({ sessionId: 'created-session' })
    await waitFor(() => expect(emptyState).toHaveAttribute('aria-busy', 'false'))
  })

  it('空态发送后在 ACP 尚未返回时把创建过渡层放在聊天 viewport 中', async () => {
    let finishCreation: ((value: { sessionId: string }) => void) | undefined
    const { host, services, lifecycle } = mountPreview()
    services.commands.setHandler('createSession', vi.fn(() => new Promise<{ sessionId: string }>(resolve => { finishCreation = resolve })))
    lifecycle.update({ sheetId: 'sheet-a', sessionId: null, preview: true, workspaceMode: 'chat' })
    const prompt = await screen.findByRole('textbox', { name: '消息输入' })
    fireEvent.input(prompt, { target: { value: '立即进入过渡' } })
    fireEvent.keyDown(prompt, { key: 'Enter', code: 'Enter', shiftKey: false })

    await waitFor(() => {
      const center = host.querySelector('.control-center')
      expect(center).toHaveAttribute('data-creation-state', 'creating')
      const progress = host.querySelector('[data-creation-progress]')
      expect(progress).not.toBeNull()
      expect(progress?.closest('[data-creation-overlay-host]')).not.toBeNull()
      expect(progress?.closest('.control-center')).toBeNull()
      expect(host.querySelector('.solid-workbench-empty-chat-viewport')).not.toBeNull()
    })
    finishCreation?.({ sessionId: 'created-session' })
    await waitFor(() => expect(host.querySelector('[data-creation-progress]')).toBeNull())
  })

  it('创建失败分支保留已选会话并停止创建进度', async () => {
    const { host, services, lifecycle } = mountPreview()
    const creation = services.commands.sessionCreation as WorkbenchSessionCreationStore
    lifecycle.update({ sheetId: 'sheet-a', sessionId: 'created-session', preview: true, workspaceMode: 'chat' })
    const attempt = creation.begin()
    creation.markSessionSelected(attempt, 'created-session')
    creation.markFailed(attempt, '首条请求失败', 'created-session')

    await waitFor(() => {
      expect(host.querySelector('.solid-workbench-chat-shell[data-chat-viewport="session"]')).not.toBeNull()
      expect(host.querySelector('.solid-agent-workbench')).toHaveAttribute('data-creation-state', 'creation-failed')
    })
    expect(host.querySelector('[data-creation-progress]')).toBeNull()
    expect(host.querySelector('.solid-workbench-chat-shell')?.getAttribute('data-chat-viewport')).toBe('session')
  })

  it('首条 prompt 异步失败时保留可重试草稿并把焦点交回输入栏', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    hosts.push(host)
    const services = createPreviewWorkbenchServices()
    servicesList.push(services)
    const createdSession: Session = {
      id: 'created-session', source: 'local:created-session', agentId: 'peri', profileId: 'profile-a', name: 'Created',
      createdAt: 1, lastActiveAt: 1, platform: 'local', workdir: '', sessionPrompt: '', skills: [], hooks: [], autoName: '',
    }
    const lifecycleRef: { current?: ReturnType<typeof mountSolidWorkbench> } = {}
    services.commands = createAgentWorkbenchCommandFacade({
      resolveSession: id => id === createdSession.id ? createdSession : undefined,
      createSession: vi.fn(async () => ({ sessionId: createdSession.id })),
      sendMessage: vi.fn(async () => { throw new Error('provider rejected first prompt') }),
      optimisticUser: () => {}, rejectOptimisticUser: () => {}, optimisticDocument: () => {}, rejectOptimisticDocument: () => {},
      selectSession: id => { if (id) lifecycleRef.current?.update({ sheetId: 'sheet-a', sessionId: id, preview: true, workspaceMode: 'chat', reducedMotion: true }) },
    }) as typeof services.commands
    const lifecycle = mountSolidWorkbench({
      host,
      input: { sheetId: 'sheet-a', sessionId: null, preview: true, workspaceMode: 'chat', reducedMotion: true },
      services,
    })
    lifecycleRef.current = lifecycle
    const prompt = await screen.findByRole('textbox', { name: '消息输入' })
    fireEvent.input(prompt, { target: { value: '保留并重试这条消息' } })
    fireEvent.keyDown(prompt, { key: 'Enter', code: 'Enter', shiftKey: false })

    await waitFor(() => {
      expect(host.querySelector('.input-error')).toHaveTextContent('provider rejected first prompt')
      expect(services.sessionUi.get('created-session', 'draft', '')).toBe('保留并重试这条消息')
      expect(prompt).toHaveValue('保留并重试这条消息')
      expect(prompt).toHaveFocus()
    })
  })

  it('空态品牌使用聊天 viewport 几何容器且不改写现有 Pylon 向量路径', async () => {
    const { host, lifecycle } = mountPreview()
    lifecycle.update({ sheetId: 'sheet-a', sessionId: null, preview: true, workspaceMode: 'chat', rightInset: 96 })
    const viewport = await waitFor(() => {
      const value = host.querySelector<HTMLElement>('.solid-workbench-empty-chat-viewport')
      expect(value).not.toBeNull()
      return value!
    })
    const brand = host.querySelector<HTMLElement>('.solid-workbench-empty-brand')!
    const mark = brand.querySelector<SVGSVGElement>('.pylon-mark')!
    expect(viewport.closest('[data-chat-viewport="empty"]')).toBeTruthy()
    expect(brand).toHaveClass('agent-empty-state')
    expect(mark).toHaveAttribute('viewBox', '0 0 64 64')
    expect(mark.querySelector('.pylon-mark-frame')).toHaveAttribute('d', 'M32 7 53 19v26L32 57 11 45V19Z')
    expect(mark.querySelector('.pylon-mark-links')).toHaveAttribute('d', 'm30 24.679-8 13.857m20 0-8-13.857M24 42h16')
  })

  it('创建后不把模型/模式协商选项渲染成会话区配置卡，且弹层不会残留', async () => {
    const { host, services, lifecycle } = mountPreview()
    lifecycle.update({ sheetId: 'sheet-a', sessionId: null, preview: true, workspaceMode: 'chat' })
    const modelTrigger = await screen.findByRole('button', { name: /deepseek-v4-flash/ })
    fireEvent.click(modelTrigger)
    expect(screen.getByRole('listbox', { name: '模型列表' })).toBeTruthy()

    lifecycle.update({ sheetId: 'sheet-a', sessionId: 'created-session', preview: true, workspaceMode: 'chat' })
    services.runtime.replaceDocument(projectWorkbench([createWorkbenchEnvelope({
      eventId: 'session-response-test', sessionId: 'created-session', sequence: 1,
      recordedAt: '2026-09-01T00:00:00.000Z', source: { provider: 'acp', sourceId: 'response' },
      identity: { runId: 'response' }, provenance: { origin: 'local-observed', trust: 'authoritative' },
      event: { type: 'session.started', status: 'ready', model: 'deepseek-v4-flash', mode: 'auto', options: [
        { id: 'model', label: '模型', valueType: 'select', value: 'deepseek-v4-flash', editable: true, schema: { options: [{ id: 'deepseek-v4-flash', label: 'deepseek-v4-flash' }] } },
        { id: 'mode', label: '模式', valueType: 'select', value: 'auto', editable: true, schema: { options: [{ id: 'auto', label: '全自动' }] } },
      ] },
    })]).document, { ownerKey: 'owner-preview', generation: 1, sessionId: 'created-session' })

    await waitFor(() => expect(host.querySelector('.solid-workbench-chat-shell')).not.toBeNull())
    expect(screen.queryByRole('listbox', { name: '模型列表' })).toBeNull()
    expect(host.querySelector('.solid-workbench-config')).toBeNull()
  })

  it('空态创建失败后保留草稿与工作区，并把焦点交还输入框', async () => {
    const { services, lifecycle } = mountPreview()
    services.commands.setHandler('createSession', vi.fn(async () => { throw new Error('Agent 暂时不可用') }))
    lifecycle.update({
      sheetId: 'sheet-a', sessionId: null, preview: true, workspaceMode: 'work',
      availableWorkspaces: [{ id: 'workspace-a', label: 'Prism', path: 'G:/Project/prism' }],
    })
    const prompt = await screen.findByRole('textbox', { name: '消息输入' })
    fireEvent.input(prompt, { target: { value: '保留这份任务描述' } })
    fireEvent.keyDown(prompt, { key: 'Enter', code: 'Enter', shiftKey: false })

    expect(await screen.findByRole('alert')).toHaveTextContent('Agent 暂时不可用')
    expect(screen.queryByRole('status', { name: '正在创建会话' })).toBeNull()
    expect(prompt).toHaveValue('保留这份任务描述')
    expect(screen.getByRole('combobox', { name: '新会话工作区' })).toHaveValue('workspace-a')
    expect(prompt).toBeEnabled()
    expect(prompt).toHaveFocus()
  })

  it('pause 冻结 runtime/appearance 推送，resume 一次收敛最新快照', async () => {
    const { host, services, lifecycle } = mountPreview()
    lifecycle.pause()
    services.runtime.update({ streamingText: '暂停期间的新文本', tokenCount: 99 })
    services.appearance.dispatch({ type: 'set-cc-edit-mode', enabled: true })

    expect(host.querySelector('[data-paused="true"]')).toBeTruthy()
    expect(screen.queryByText('暂停期间的新文本')).toBeNull()

    lifecycle.resume()
    await waitFor(() => expect(screen.getByText('暂停期间的新文本')).toBeTruthy())
    expect(host.querySelector('[data-paused="false"]')).toBeTruthy()
  })

  it('preview 不暴露真实停止按钮，destroy 幂等并清空 DOM', () => {
    const { host, lifecycle } = mountPreview()
    expect(screen.queryByTitle('停止生成 (Esc / Ctrl+C)')).toBeNull()

    lifecycle.destroy()
    lifecycle.destroy()
    expect(host.childElementCount).toBe(0)
  })

  it('生产中控消费提交模式、隐藏项与布局槽位权威', async () => {
    const { host, services, lifecycle } = mountPreview()
    const theme = structuredClone(DEFAULTS)
    theme.inputMode = 'default'
    theme.inputVariant = 'composer'
    theme.inputSubmitButtonMode = 'inline'
    services.appearance.setTheme(theme)

    await waitFor(() => expect(screen.getByRole('button', { name: '停止生成' })).toBeTruthy())
    expect(host.querySelector('.cc-send-icon, .cc-send-square, .cc-send-minimal')).toBeNull()
    expect(host.querySelector('.cc-attach-icon, .cc-attach-square, .cc-attach-minimal')).toBeNull()
    expect(screen.getAllByRole('button', { name: '停止生成' })).toHaveLength(1)

    theme.inputSubmitButtonMode = 'external'
    theme.ccHidden = ['attach']
    theme.ccLayout.placements.send = { slot: 'actions', order: 0, offsetX: 0, offsetY: 0 }
    theme.ccLayout.placements.model = { slot: 'actions', order: 1, offsetX: 0, offsetY: 0 }
    services.appearance.setTheme(theme)

    await waitFor(() => expect(host.querySelector('.cc-actions [data-widget-id="send"]')).toBeTruthy())
    expect(host.querySelector('[data-widget-id="attach"]')).toBeNull()
    expect(Array.from(host.querySelectorAll('.cc-actions [data-widget-id]')).map(node => node.getAttribute('data-widget-id')))
      .toEqual(['send', 'model'])

    lifecycle.update({
      sheetId: 'sheet-a', sessionId: 'preview-session', preview: true,
      presentationProfileId: 'builtin.presentation.terminal-classic',
    })
    await waitFor(() => expect(host.querySelector('[data-widget-id="session"]')).toBeNull())
    expect(host.querySelector('[data-widget-id="workspace"]')).toBeNull()
    expect(host.querySelector('[data-widget-id="activity"]')).toBeNull()
  })

  it('外置按钮模式下单独隐藏发送或附件不会误吞掉输入栏另一按钮', async () => {
    const { host, services } = mountPreview()
    const theme = structuredClone(DEFAULTS)
    theme.inputMode = 'default'
    theme.inputVariant = 'composer'
    theme.inputSubmitButtonMode = 'external'
    theme.ccHidden = ['send']
    services.appearance.setTheme(theme)

    await waitFor(() => expect(host.querySelector('[data-widget-id="attach"]')).toBeTruthy())
    expect(host.querySelector('[data-widget-id="send"]')).toBeNull()
    expect(host.querySelector('.input-btn.send, .input-btn.stop')).toHaveAttribute('aria-label', '停止生成')
    expect(host.querySelector('.input-btn.attach')).toBeNull()

    theme.ccHidden = ['attach']
    services.appearance.setTheme(theme)
    await waitFor(() => expect(host.querySelector('[data-widget-id="send"]')).toBeTruthy())
    expect(host.querySelector('[data-widget-id="attach"]')).toBeNull()
    expect(host.querySelector('.input-btn.send, .input-btn.stop')).toBeNull()
    expect(host.querySelector('.input-btn.attach')).toHaveAttribute('aria-label', '添加附件')
  })

  it('中控编辑模式可选择并拖动 widget，布局写回 appearance 权威', async () => {
    const { host, services } = mountPreview()
    services.appearance.dispatch({ type: 'set-cc-edit-mode', enabled: true })

    const model = await waitFor(() => {
      const value = host.querySelector<HTMLElement>('[data-widget-id="model"]')
      expect(value).not.toBeNull()
      return value!
    })
    fireEvent.pointerDown(model, { clientX: 10, clientY: 20, pointerId: 1 })

    expect(screen.getByRole('dialog', { name: '模型 属性' })).toBeTruthy()
    fireEvent.pointerMove(window, { clientX: 34, clientY: 12, pointerId: 1 })
    fireEvent.pointerUp(window, { pointerId: 1 })

    await waitFor(() => expect(services.appearance.getSnapshot().ccLayout.placements.model).toMatchObject({ offsetX: 24, offsetY: -8 }))
  })

  it('控件拖拽只响应发起拖拽的 pointer', async () => {
    const { host, services } = mountPreview()
    services.appearance.dispatch({ type: 'set-cc-edit-mode', enabled: true })
    const model = await waitFor(() => {
      const value = host.querySelector<HTMLElement>('[data-widget-id="model"]')
      expect(value).not.toBeNull()
      return value!
    })

    fireEvent.pointerDown(model, { clientX: 10, clientY: 20, pointerId: 1 })
    fireEvent.pointerMove(window, { clientX: 40, clientY: 40, pointerId: 2 })
    fireEvent.pointerUp(window, { pointerId: 2 })
    expect(services.appearance.getSnapshot().ccLayout.placements.model).toMatchObject({ offsetX: 0, offsetY: 0 })

    fireEvent.pointerMove(window, { clientX: 34, clientY: 12, pointerId: 1 })
    fireEvent.pointerUp(window, { pointerId: 1 })
    expect(services.appearance.getSnapshot().ccLayout.placements.model).toMatchObject({ offsetX: 24, offsetY: -8 })
  })

  it('中控编辑工具栏可隐藏、恢复、重置并退出', async () => {
    const { host, services } = mountPreview()
    services.appearance.dispatch({ type: 'set-cc-edit-mode', enabled: true })

    expect(await screen.findByRole('toolbar', { name: '中控控件工具栏' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '隐藏 模型' }))
    await waitFor(() => expect(services.appearance.getSnapshot().ccHidden).toContain('model'))
    expect(host.querySelector('[data-widget-id="model"]')).toHaveClass('cc-hidden')

    fireEvent.click(screen.getByRole('button', { name: '显示 模型' }))
    await waitFor(() => expect(services.appearance.getSnapshot().ccHidden).not.toContain('model'))

    services.appearance.dispatch({ type: 'update-cc-placement', id: 'model', placement: { offsetX: 20 } })
    fireEvent.click(screen.getByRole('button', { name: '重置控件位置' }))
    await waitFor(() => expect(services.appearance.getSnapshot().ccLayout.placements.model.offsetX).toBe(0))

    fireEvent.click(screen.getByRole('button', { name: '退出中控编辑' }))
    await waitFor(() => expect(services.appearance.getSnapshot().ccEditMode).toBe(false))
    expect(screen.queryByRole('toolbar', { name: '中控控件工具栏' })).toBeNull()
  })

  it('属性面板可编辑槽位、顺序、偏移、缩放和 schema 外观字段', async () => {
    const { host, services } = mountPreview()
    services.appearance.dispatch({ type: 'set-cc-edit-mode', enabled: true })
    fireEvent.click(await screen.findByRole('button', { name: '模型 属性' }))

    fireEvent.change(screen.getByLabelText('控件槽位'), { target: { value: 'actions' } })
    fireEvent.input(screen.getByLabelText('控件顺序'), { target: { value: '7' } })
    fireEvent.input(screen.getByLabelText('水平微调'), { target: { value: '12' } })
    fireEvent.input(screen.getByLabelText('控件缩放'), { target: { value: '125' } })
    fireEvent.click(screen.getByRole('button', { name: '简洁' }))

    await waitFor(() => expect(services.appearance.getSnapshot().ccLayout.placements.model).toMatchObject({ slot: 'actions', order: 7, offsetX: 12 }))
    expect(services.appearance.getSnapshot().ccScale.model).toBe(125)
    expect(services.appearance.getSnapshot().modelVariant).toBe('minimal')
    expect(host.querySelector('[data-widget-id="model"] .cc-model-minimal')).toBeTruthy()
  })

  it('属性面板数字输入清空时保留上次有效值', async () => {
    const { services } = mountPreview()
    services.appearance.dispatch({ type: 'update-cc-placement', id: 'model', placement: { order: 7, offsetX: 12 } })
    services.appearance.dispatch({ type: 'set-cc-scale', id: 'model', scale: 125 })
    services.appearance.dispatch({ type: 'set-cc-edit-mode', enabled: true })
    fireEvent.click(await screen.findByRole('button', { name: '模型 属性' }))

    fireEvent.input(screen.getByLabelText('控件顺序'), { target: { value: '' } })
    fireEvent.input(screen.getByLabelText('水平微调'), { target: { value: '' } })
    fireEvent.input(screen.getByLabelText('控件缩放'), { target: { value: '' } })

    expect(services.appearance.getSnapshot().ccLayout.placements.model).toMatchObject({ order: 7, offsetX: 12 })
    expect(services.appearance.getSnapshot().ccScale.model).toBe(125)
  })

  it('属性 schema 的联动字段和条件字段在 Solid 面板中保持响应式', async () => {
    const { services } = mountPreview()
    services.appearance.dispatch({ type: 'set-cc-edit-mode', enabled: true })
    fireEvent.click(await screen.findByRole('button', { name: '输入栏 属性' }))
    fireEvent.click(screen.getByRole('button', { name: '命令行' }))

    await waitFor(() => expect(services.appearance.getSnapshot()).toMatchObject({ inputMode: 'cli', inputVariant: 'cli' }))
    const lineColor = screen.getByLabelText('边框颜色')
    fireEvent.change(lineColor, { target: { value: '#123456' } })
    await waitFor(() => expect(services.appearance.getSnapshot().ccProperties.cliLineColor).toBe('#123456'))
  })

  it('生产 HostPort 挂载路径可将属性面板修改写回 appearance 权威', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    hosts.push(host)
    const services = createPreviewWorkbenchServices()
    servicesList.push(services)
    const hostPort = createWorkbenchHostPort({
      ...services,
      suiteId: 'builtin.solid', sheetId: 'sheet-a', sessionOwnerKey: 'owner-preview', sessionId: 'preview-session',
      capabilities: { appearanceEdit: true },
    })
    const lifecycle = mountSolidWorkbenchFromHostPort({
      host,
      input: {
        sheetId: 'sheet-a', sessionOwnerKey: 'owner-preview', sessionId: 'preview-session',
        workspaceMode: 'work', replayReadonly: false, reducedMotion: true,
        visibility: 'active', rightInset: 0, preview: true,
      },
      hostPort,
    })
    services.appearance.dispatch({ type: 'set-cc-edit-mode', enabled: true })

    fireEvent.click(await screen.findByRole('button', { name: '模型 属性' }))
    fireEvent.click(screen.getByRole('button', { name: '简洁' }))

    await waitFor(() => expect(services.appearance.getSnapshot().modelVariant).toBe('minimal'))
    lifecycle.destroy()
  })

  it('编辑器可拖动整体高度，destroy 会清理窗口级拖拽监听', async () => {
    const { services, lifecycle } = mountPreview()
    services.appearance.dispatch({ type: 'set-cc-edit-mode', enabled: true })
    const initial = services.appearance.getSnapshot().ccHeight
    const handle = await screen.findByRole('separator', { name: '调整中控高度' })

    fireEvent.pointerDown(handle, { clientY: 100, pointerId: 2 })
    fireEvent.pointerMove(window, { clientY: 80, pointerId: 2 })
    await waitFor(() => expect(services.appearance.getSnapshot().ccHeight).toBe(initial + 20))

    lifecycle.destroy()
    fireEvent.pointerMove(window, { clientY: 40, pointerId: 2 })
    expect(services.appearance.getSnapshot().ccHeight).toBe(initial + 20)
  })

  it('高度拖拽只响应发起拖拽的 pointer', async () => {
    const { services } = mountPreview()
    services.appearance.dispatch({ type: 'set-cc-edit-mode', enabled: true })
    const initial = services.appearance.getSnapshot().ccHeight
    const handle = await screen.findByRole('separator', { name: '调整中控高度' })

    fireEvent.pointerDown(handle, { clientY: 100, pointerId: 1 })
    fireEvent.pointerMove(window, { clientY: 40, pointerId: 2 })
    fireEvent.pointerUp(window, { pointerId: 2 })
    expect(services.appearance.getSnapshot().ccHeight).toBe(initial)

    fireEvent.pointerMove(window, { clientY: 80, pointerId: 1 })
    fireEvent.pointerUp(window, { pointerId: 1 })
    expect(services.appearance.getSnapshot().ccHeight).toBe(initial + 20)
  })

  it('Escape 先关闭属性面板，再退出中控编辑模式', async () => {
    const { services } = mountPreview()
    services.appearance.dispatch({ type: 'set-cc-edit-mode', enabled: true })
    fireEvent.click(await screen.findByRole('button', { name: '模型 属性' }))
    expect(screen.getByRole('dialog', { name: '模型 属性' })).toBeTruthy()

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: '模型 属性' })).toBeNull()
    expect(services.appearance.getSnapshot().ccEditMode).toBe(true)

    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(services.appearance.getSnapshot().ccEditMode).toBe(false))
  })

  it('exposes ready lifecycle event and removes listeners on destroy', () => {
    const { lifecycle } = mountPreview()
    const ready = vi.fn()
    const unsubscribe = lifecycle.on('ready', ready)
    expect(ready).toHaveBeenCalledWith({ suiteId: 'builtin.solid' })
    unsubscribe()
    lifecycle.destroy()
  })

  it('Solid component render fatal is emitted through renderer lifecycle for Host fallback', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    hosts.push(host)
    const services = createPreviewWorkbenchServices()
    servicesList.push(services)
    const snapshot = services.runtime.getSnapshot()
    services.runtime.getSnapshot = () => new Proxy(snapshot, {
      get(target, property, receiver) {
        if (property === 'document') throw new Error('solid component exploded')
        return Reflect.get(target, property, receiver)
      },
    })

    const lifecycle = mountSolidWorkbench({
      host, input: { sheetId: 'sheet-a', sessionId: 'preview-session' }, services,
    })
    const error = vi.fn()
    lifecycle.on('error', error)

    await waitFor(() => expect(error).toHaveBeenCalledWith(expect.objectContaining({ message: 'solid component exploded' })))
  })

  it('Suite Host catches an initial Solid component fatal even when lifecycle subscription follows mount', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    hosts.push(host)
    const services = createPreviewWorkbenchServices()
    servicesList.push(services)
    const healthy = services.runtime.getSnapshot()
    services.runtime.getSnapshot = () => new Proxy(healthy, {
      get(target, property, receiver) {
        if (property === 'document') throw new Error('initial solid component exploded')
        return Reflect.get(target, property, receiver)
      },
    })
    const diagnostics: unknown[] = []
    const base = createWorkbenchHostPort({
      ...services, suiteId: 'builtin.solid', sheetId: 'sheet-a',
      sessionOwnerKey: 'owner-a', sessionId: 'preview-session',
    })
    const hostPort = {
      ...base,
      document: {
        getSnapshot: () => healthy.document,
        subscribe: () => () => {},
        getSlice: <T,>() => undefined as T,
        subscribeSlice: () => () => {},
      },
      diagnostics: { report: (value: unknown) => diagnostics.push(value), getRecent: () => [], subscribe: () => () => {} },
    }
    const suite: RendererSuiteContribution = {
      id: 'builtin.solid', label: 'Builtin Solid', apiVersion: 1,
      runtime: { framework: 'solid', version: '1' },
      compatibility: { documentSchema: 'workbench.v1', renderCatalogSchema: 1 },
      requiredKinds: ['content.unknown'],
      factory: {
        async prepare() {
          return { mount(container, input) { return mountSolidWorkbench({ host: container, input, services }) } }
        },
      },
    }
    const activation: RendererActivationSnapshot = {
      revision: 1,
      suite: { ownerPluginId: 'builtin.pylon-renderers', ownerRuntimeInstanceId: 'runtime', contributionId: suite.id, layer: 'feature', priority: 1, value: suite } as RegistryEntry<RendererSuiteContribution>,
      kinds: new Map(), slots: new Map(), diagnostics: [],
    }
    const suiteHost = new RendererSuiteHost({
      container: host, hostPort: hostPort as never,
      input: {
        sheetId: 'sheet-a', sessionOwnerKey: 'owner-a', sessionId: 'preview-session', workspaceMode: 'work',
        replayReadonly: false, reducedMotion: false, visibility: 'active', rightInset: 0, preview: false,
      },
    })

    await suiteHost.mount(activation)

    expect(suiteHost.getState().phase).toBe('degraded')
    expect(diagnostics).toContainEqual(expect.objectContaining({
      code: 'renderer.suite.switch.failed', phase: 'mount', recoverability: 'retry',
      message: 'initial solid component exploded',
    }))
    await suiteHost.destroy()
  })

  it('通过 Suite Host 注入的 HostPort 由宿主管理，renderer destroy 不销毁共享 diagnostics', () => {
    const host = document.createElement('div')
    document.body.append(host)
    hosts.push(host)
    const services = createPreviewWorkbenchServices()
    servicesList.push(services)
    const hostPort = createWorkbenchHostPort({
      ...services, suiteId: 'builtin.solid', sheetId: 'sheet-a',
      sessionOwnerKey: 'owner-a', sessionId: 'preview-session',
    })
    const destroyDiagnostics = vi.spyOn(hostPort.diagnostics, 'destroy')
    const lifecycle = mountSolidWorkbench({
      host, input: { sheetId: 'sheet-a', sessionId: 'preview-session' }, services, hostPort,
    })

    lifecycle.destroy()

    expect(destroyDiagnostics).not.toHaveBeenCalled()
  })

  it('document apply 驱动消息、活动与 diagnostics，并暂不展示 ChatView usage surface', async () => {
    const { host, services } = mountPreview()
    const envelope = (sequence: number, event: WorkbenchEventEnvelope['event']): WorkbenchEventEnvelope => createWorkbenchEnvelope({
      sessionId: 'preview-session', recordedAt: `2026-08-21T00:00:0${sequence}.000Z`, sequence,
      source: { provider: 'peri', sourceId: `solid-${sequence}` }, provenance: { origin: 'local-observed', trust: 'authoritative' }, event,
    })
    const workbenchDocument = projectWorkbench([
      envelope(1, { type: 'message.delta', role: 'assistant', parts: [{ kind: 'text', text: 'canonical answer' }] }),
      envelope(2, { type: 'tool.started', tool: { toolCallId: 'tool-1', name: 'Read', status: 'running' } }),
      envelope(3, { type: 'usage.updated', usage: { inputTokens: 8 } }),
      envelope(4, { type: 'diagnostic.notice', level: 'warning', code: 'demo.warning', message: 'canonical warning' }),
      envelope(5, { type: 'budget.warning', used: 90, limit: 100, remaining: 10, exhausted: false }),
      envelope(6, { type: 'session.config-updated', options: [{ id: 'model', label: 'Model', value: 'gpt-5', version: 1 }] }),
      envelope(7, { type: 'session.commands-updated', commands: [{ id: 'review', name: '/review', description: '审查改动' }] }),
      envelope(8, { type: 'assist.prediction', placeholder: '继续审计', actions: [] }),
      envelope(9, { type: 'assist.file-suggestions', files: ['src/a.ts'] }),
    ]).document
    services.runtime.replaceDocument(workbenchDocument, { ownerKey: 'owner-preview', generation: 1 })
    await waitFor(() => expect(screen.getByText('canonical answer')).toBeTruthy())
    expect(host.querySelector('[data-activity-count="1"]')).toBeTruthy()
    expect(host.querySelector('[data-has-usage="true"]')).toBeNull()
    expect(screen.queryByLabelText('会话用量')).toBeNull()
    expect(screen.queryByLabelText('会话预算')).toBeNull()
    expect(screen.getByLabelText('编辑 Model')).toHaveValue('gpt-5')
    expect(screen.getByLabelText('会话命令')).toHaveTextContent('/review')
    expect(screen.getByLabelText('输入预测')).toHaveTextContent('继续审计')
    expect(screen.getByLabelText('文件建议')).toHaveTextContent('src/a.ts')
    expect(host.textContent).not.toContain('↓ 8 tokens')
    expect(host.querySelector('[data-widget-id="tokens"]')).toHaveTextContent('8/—')
    expect(screen.getByText('canonical warning')).toBeTruthy()
  })

  it('同一 error 事实只渲染一个可见错误 surface', async () => {
    const { host, services } = mountPreview()
    const projected = projectWorkbench([createWorkbenchEnvelope({
      sessionId: 'preview-session', sequence: 1, recordedAt: '2026-08-25T00:00:01.000Z',
      source: { provider: 'peri', sourceId: 'error-1' }, identity: {},
      provenance: { origin: 'local-observed', trust: 'authoritative' },
      event: { type: 'diagnostic.notice', level: 'error', code: 'transport.timeout', message: '连接超时' },
    })]).document

    services.runtime.replaceDocument(projected, { ownerKey: 'owner-preview', generation: 1 })

    await waitFor(() => expect(host.querySelectorAll('[role="alert"]')).toHaveLength(1))
    expect(host.querySelector('.system-error-card')).toHaveTextContent('连接超时')
    expect(host.querySelector('.system-notice-card')).toBeNull()
  })

  it('C04 canonical unknown tool uses the typed tool.generic base Slot and updates without remount', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    hosts.push(host)
    const services = createPreviewWorkbenchServices()
    servicesList.push(services)
    const slot = createBuiltinSolidContentSlot()
    const slotEntry = {
      ownerPluginId: 'builtin.pylon-renderers', ownerRuntimeInstanceId: 'runtime',
      contributionId: slot.id, layer: 'feature', priority: slot.priority, value: slot,
    } as RegistryEntry<RendererSlotContribution>
    const suite = { id: 'builtin.solid' } as RendererSuiteContribution
    const kindEntries = BUILTIN_TOOL_RENDER_KINDS.map(kind => [kind.id, {
      ownerPluginId: 'core.renderer.tool-kinds', ownerRuntimeInstanceId: 'runtime',
      contributionId: kind.id, layer: 'feature', priority: kind.priority, value: kind,
    } as RegistryEntry<(typeof BUILTIN_TOOL_RENDER_KINDS)[number]>] as const)
    const specializedToolKind = {
      ...BUILTIN_TOOL_RENDER_KINDS[0]!, id: 'tool.unregistered', fallbackKind: 'tool.generic',
      fixture: { id: 'fixture-specialized', name: 'SpecializedTool', status: 'running', semanticKind: 'tool.unregistered' },
    }
    const specializedToolEntry = {
      ownerPluginId: 'core.renderer.semantic-kinds', ownerRuntimeInstanceId: 'runtime',
      contributionId: specializedToolKind.id, layer: 'feature', priority: specializedToolKind.priority,
      value: specializedToolKind,
    } as RegistryEntry<typeof specializedToolKind>
    const activation: RendererActivationSnapshot = {
      revision: 1,
      suite: {
        ownerPluginId: 'builtin.pylon-renderers', ownerRuntimeInstanceId: 'runtime',
        contributionId: suite.id, layer: 'feature', priority: 1, value: suite,
      } as RegistryEntry<RendererSuiteContribution>,
      kinds: new Map([...kindEntries, ['tool.unregistered', specializedToolEntry]]),
      slots: new Map(BUILTIN_TOOL_RENDER_KINDS.map(kind => [kind.id, [slotEntry]])),
      diagnostics: [],
    }
    mountSolidWorkbench({
      host,
      input: { sheetId: 'sheet-a', sessionId: 'preview-session' },
      services,
      activation,
    })
    const started = projectWorkbench([createWorkbenchEnvelope({
      sessionId: 'preview-session', recordedAt: '2026-08-22T00:00:01.000Z', sequence: 1,
      source: { provider: 'peri', sourceId: 'tool-start' }, identity: { toolCallId: 'tool-c04' },
      provenance: { origin: 'local-observed', trust: 'authoritative' },
      event: {
        type: 'tool.started',
        tool: {
          name: 'ProviderRead', canonicalName: 'read_file', title: '读取文件',
          semanticKind: 'tool.unregistered', status: 'running', input: { path: '/normalized.txt' },
        },
      },
    })]).document

    services.runtime.replaceDocument(started, { ownerKey: 'owner-preview', generation: 1 })

    const card = await screen.findByRole('status', { name: '工具：读取文件，运行中' })
    expect(card).toHaveAttribute('data-content-kind', 'tool.generic')
    expect(card).toHaveTextContent('ProviderRead')
    expect(card.querySelector('.term-tool-head')).toHaveAttribute('aria-expanded', 'false')
    expect(card).not.toHaveTextContent('/normalized.txt')
    fireEvent.click(card.querySelector<HTMLButtonElement>('.term-tool-head')!)
    expect(card).toHaveTextContent('/normalized.txt')
    expect(host.querySelector('.solid-workbench-activity')).toBeNull()
    expect(card.closest('[data-renderer-slot-id="builtin.solid.content.base"]')).not.toBeNull()

    const completed = reduceWorkbenchEvent(started, createWorkbenchEnvelope({
      sessionId: 'preview-session', recordedAt: '2026-08-22T00:00:02.000Z', sequence: 2,
      source: { provider: 'peri', sourceId: 'tool-complete' }, identity: { toolCallId: 'tool-c04' },
      provenance: { origin: 'local-observed', trust: 'authoritative' },
      event: { type: 'tool.completed', tool: { status: 'completed', parts: [{ kind: 'text', text: 'file body' }], durationMs: 1200 } },
    }))
    services.runtime.replaceDocument(completed, { ownerKey: 'owner-preview', generation: 1 })

    await waitFor(() => expect(card).toHaveAccessibleName('工具：读取文件，已完成'))
    expect(screen.getByRole('status', { name: '工具：读取文件，已完成' })).toBe(card)
    expect(card).toHaveTextContent('file body')
    expect(card).toHaveTextContent('1.2s')
    const cardHead = card.querySelector<HTMLButtonElement>('.term-tool-head')!
    fireEvent.click(cardHead)
    expect(cardHead).toHaveAttribute('aria-expanded', 'false')

    const nested = reduceWorkbenchEvent(completed, createWorkbenchEnvelope({
      sessionId: 'preview-session', recordedAt: '2026-08-22T00:00:03.000Z', sequence: 3,
      source: { provider: 'peri', sourceId: 'tool-child' }, identity: { toolCallId: 'tool-c04-child' },
      provenance: { origin: 'local-observed', trust: 'authoritative' },
      event: {
        type: 'tool.started',
        tool: { name: 'ChildTool', title: '子工具', semanticKind: 'tool.unregistered', parentToolUseId: 'tool-c04' },
      },
    }))
    services.runtime.replaceDocument(nested, { ownerKey: 'owner-preview', generation: 1 })

    const connector = await waitFor(() => {
      const value = host.querySelector<HTMLElement>('[data-from-message-id="tool-c04"][data-to-message-id="tool-c04-child"]')
      expect(value).not.toBeNull()
      return value!
    })
    expect(connector).toHaveClass('term-tool-connector')

    const replacement = projectWorkbench([createWorkbenchEnvelope({
      sessionId: 'preview-session', recordedAt: '2026-08-22T00:00:04.000Z', sequence: 4,
      source: { provider: 'peri', sourceId: 'tool-replacement' }, identity: { toolCallId: 'tool-replacement' },
      provenance: { origin: 'local-observed', trust: 'authoritative' },
      event: { type: 'tool.started', tool: { name: 'Replacement', title: '替换工具', semanticKind: 'tool.unregistered' } },
    })]).document
    services.runtime.replaceDocument(replacement, { ownerKey: 'owner-preview', generation: 2 })

    const replacementCard = await screen.findByRole('status', { name: '工具：替换工具，运行中' })
    expect(replacementCard).not.toBe(card)
    expect(replacementCard.querySelector('.term-tool-head')).toHaveAttribute('aria-controls', 'solid-tool-snapshot-tool-replacement')
    expect(replacementCard.querySelector('.term-tool-head')).toHaveAttribute('aria-expanded', 'false')
    expect(replacementCard.querySelector('#solid-tool-snapshot-tool-replacement')).toBeNull()
    expect(host.querySelector('[data-from-message-id="tool-c04"]')).toBeNull()
  })

  it('canonical media part reaches the committed Solid media renderer in production', async () => {
    const { services } = mountPreview()
    const document = projectWorkbench([createWorkbenchEnvelope({
      sessionId: 'preview-session', recordedAt: '2026-08-21T00:00:01.000Z', sequence: 1,
      source: { provider: 'hermes', sourceId: 'media-1' },
      provenance: { origin: 'local-observed', trust: 'authoritative' },
      event: {
        type: 'message.delta', role: 'assistant',
        parts: [{ kind: 'image', source: 'https://cdn.example.com/architecture.png', alt: '架构图' }],
      },
    })]).document

    services.runtime.replaceDocument(document, { ownerKey: 'owner-preview', generation: 1 })

    expect(await screen.findByRole('img', { name: '架构图' })).toHaveAttribute(
      'src', 'https://cdn.example.com/architecture.png',
    )
  })

  it('C06 canonical diff and LSP parts reach their production base Slot kinds', async () => {
    const { host, services } = mountPreview()
    const document = projectWorkbench([createWorkbenchEnvelope({
      sessionId: 'preview-session', recordedAt: '2026-08-23T00:00:01.000Z', sequence: 1,
      source: { provider: 'peri', sourceId: 'c06-content' }, identity: { messageId: 'c06-content' },
      provenance: { origin: 'local-observed', trust: 'authoritative' },
      event: {
        type: 'message.delta', role: 'assistant', parts: [
          { kind: 'diff', path: '/src/production.ts', lines: [{ kind: 'added', text: 'export const ready = true' }] },
          { kind: 'diagnostic-lsp', severity: 'error', code: 'TS1005', message: 'semicolon expected', path: '/src/production.ts' },
        ],
      },
    })]).document

    services.runtime.replaceDocument(document, { ownerKey: 'owner-preview', generation: 1 })

    expect(await screen.findByRole('region', { name: 'Diff：/src/production.ts' })).toBeTruthy()
    expect(await screen.findByRole('alert', { name: 'LSP error：semicolon expected' })).toBeTruthy()
    expect(host.querySelector('[data-content-kind="content.diff"] [data-renderer-slot-id="builtin.solid.content.base"]')
      ?? host.querySelector('[data-content-kind="content.diff"]')).not.toBeNull()
    expect(host.querySelector('[data-content-kind="diagnostic.lsp"]')).not.toBeNull()
  })

  it('C07 canonical terminal and log parts remain readable through the production fallback', async () => {
    const { host, services } = mountPreview()
    const document = projectWorkbench([createWorkbenchEnvelope({
      sessionId: 'preview-session', recordedAt: '2026-08-23T00:00:02.000Z', sequence: 1,
      source: { provider: 'hermes', sourceId: 'c07-content' }, identity: { messageId: 'c07-content' },
      provenance: { origin: 'local-observed', trust: 'authoritative' },
      event: {
        type: 'message.delta', role: 'assistant', parts: [
          { kind: 'terminal', command: 'npm test', streams: [{ stream: 'stderr', text: 'failed', ordinal: 0 }], exitCode: 1 },
          { kind: 'log', source: 'runner', entries: [{ level: 'info', text: 'cleanup complete' }] },
        ],
      },
    })]).document

    services.runtime.replaceDocument(document, { ownerKey: 'owner-preview', generation: 1 })

    await waitFor(() => expect(host.querySelector('.term-terminal-card')).toHaveTextContent('failed'))
    expect(host.querySelector('.term-log-card')).toHaveTextContent('cleanup complete')
    expect(host.textContent).not.toContain('Unsupported content kind')
  })

  it('C15 canonical content and negotiated extension events reach production Slots and missing-plugin fallback', async () => {
    const { host, services } = mountPreview()
    const make = (sequence: number, event: WorkbenchEventEnvelope['event']) => createWorkbenchEnvelope({
      sessionId: 'preview-session', recordedAt: `2026-08-24T00:00:0${sequence}.000Z`, sequence,
      source: { provider: 'peri', sourceId: `c15-${sequence}` }, identity: { messageId: sequence === 1 ? 'c15-message' : undefined },
      provenance: { origin: 'local-observed', trust: 'authoritative' }, event,
    })
    const document = projectWorkbench([
      make(1, { type: 'message.delta', role: 'assistant', parts: [{ kind: 'artifact', artifactId: 'artifact-1', title: 'Production report', uri: 'artifact://report', parts: [{ kind: 'text', text: 'preview body' }] }] }),
      make(2, { type: 'extension.event', kind: 'system.hook', payload: { phase: 'turn.completed', owner: { pluginId: 'plugin.audit', handlerId: 'after' }, status: 'continued', durationMs: 11 }, fallback: [] }),
      make(3, { type: 'extension.event', kind: 'plugin.removed/result', payload: { status: 'done' }, fallback: [{ kind: 'unknown', originalType: 'plugin.removed/result', summary: 'renderer unavailable', raw: { status: 'done' }, truncated: false }] }),
    ]).document

    services.runtime.replaceDocument(document, { ownerKey: 'owner-preview', generation: 1 })

    expect(await screen.findByRole('article', { name: '工件：Production report' })).toHaveTextContent('preview body')
    expect(await screen.findByRole('status', { name: 'Hook：turn.completed' })).toHaveTextContent('11 ms')
    const missingPlugin = await screen.findByRole('note', { name: '扩展事件：plugin.removed/result' })
    expect(missingPlugin).toHaveTextContent('renderer unavailable')
    expect(missingPlugin).toHaveTextContent('peri · c15-3')
    expect(missingPlugin).toHaveTextContent('local-observed · authoritative')
    expect(host.querySelector('[data-extension-kind="plugin.removed/result"]')).not.toBeNull()
  })

  it('coalesces adjacent streamed text in a missing-plugin extension fallback', async () => {
    const { host, services } = mountPreview()
    const document = projectWorkbench([createWorkbenchEnvelope({
      sessionId: 'preview-session', recordedAt: '2026-08-24T00:00:04.000Z', sequence: 1,
      source: { provider: 'peri', sourceId: 'extension-streamed-fallback' }, identity: {},
      provenance: { origin: 'local-observed', trust: 'authoritative' },
      event: {
        type: 'extension.event', kind: 'plugin.removed/streamed', payload: { status: 'done' },
        fallback: [{ kind: 'text', text: '连续' }, { kind: 'markdown', text: '降级内容' }],
      },
    })]).document

    services.runtime.replaceDocument(document, { ownerKey: 'owner-preview', generation: 1 })

    const fallback = await screen.findByRole('note', { name: '扩展事件：plugin.removed/streamed' })
    expect(fallback).toHaveTextContent('连续降级内容')
    expect(fallback.querySelectorAll('p')).toHaveLength(1)
    expect(host.querySelectorAll('[data-extension-kind="plugin.removed/streamed"]')).toHaveLength(1)
  })

  it('C10 workflow remains readable through the built-in no-Slot fallback', async () => {
    const { host, services } = mountPreview()
    const projected = projectWorkbench([createWorkbenchEnvelope({
      sessionId: 'preview-session', recordedAt: '2026-08-24T00:00:01.000Z', sequence: 1,
      source: { provider: 'peri', sourceId: 'workflow-fallback' }, identity: { taskId: 'workflow-fallback' },
      provenance: { origin: 'local-observed', trust: 'authoritative' },
      event: {
        type: 'activity.started', activityId: 'workflow-fallback',
        activity: { kind: 'workflow', title: 'fallback workflow' },
      },
    })]).document

    services.runtime.replaceDocument(projected, { ownerKey: 'owner-preview', generation: 1 })

    await waitFor(() => expect(host.querySelector('.term-workflow-card')).toHaveTextContent('fallback workflow'))
    expect(host.querySelector('.term-subagent-card')).toBeNull()
  })

  it('C07 activity.process renders identity, output, status, and synthetic provenance outside messages', async () => {
    const { host, services } = mountPreview()
    const createActivity = (sequence: number, event: WorkbenchEventEnvelope['event']) => createWorkbenchEnvelope({
      sessionId: 'preview-session', recordedAt: `2026-08-23T00:00:0${sequence}.000Z`, sequence,
      source: { provider: 'peri', sourceId: `process-${sequence}` }, identity: { taskId: 'process-1' },
      provenance: sequence === 1
        ? { origin: 'local-observed', trust: 'authoritative' }
        : { origin: 'plugin', trust: 'unverified', orderConfidence: 'observed', synthetic: { reason: 'observed exit' } },
      event,
    })
    const workbenchDocument = projectWorkbench([
      createActivity(1, {
        type: 'activity.started', activityId: 'process-1',
        activity: { kind: 'process', title: 'background tests', processId: 'pid-7', sessionId: 'shell-2' },
      }),
      createActivity(2, {
        type: 'activity.completed', activityId: 'process-1',
        result: { parts: [{ kind: 'terminal', streams: [{ stream: 'stdout', text: 'all passed', ordinal: 0 }], exitCode: 0 }] },
      }),
    ]).document

    services.runtime.replaceDocument(workbenchDocument, { ownerKey: 'owner-preview', generation: 1 })

    await waitFor(() => expect(host.querySelector('.term-process-activity')).toHaveTextContent('background tests'))
    const process = host.querySelector('.term-process-activity')!
    expect(process).toHaveTextContent('pid-7')
    expect(process).toHaveTextContent('shell-2')
    expect(process).toHaveTextContent('completed')
    expect(process).toHaveTextContent('all passed')
    expect(process).toHaveTextContent('合成生命周期：observed exit')
    expect([...host.querySelectorAll('[data-message-role]')].map(node => node.textContent).join('')).not.toContain('all passed')
  })

  it('C07 terminal/log/process kinds mount through the production base Slot', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    hosts.push(host)
    const services = createPreviewWorkbenchServices()
    servicesList.push(services)
    const slot = createBuiltinSolidContentSlot()
    const slotEntry = {
      ownerPluginId: 'builtin.pylon-renderers', ownerRuntimeInstanceId: 'runtime',
      contributionId: slot.id, layer: 'feature', priority: slot.priority, value: slot,
    } as RegistryEntry<RendererSlotContribution>
    const kinds = [
      ...BUILTIN_TEXT_RENDER_KINDS.filter(kind => kind.id === 'content.terminal' || kind.id === 'content.log'),
      ...BUILTIN_EXECUTION_RENDER_KINDS,
    ]
    const activation: RendererActivationSnapshot = {
      revision: 1,
      suite: {
        ownerPluginId: 'builtin.pylon-renderers', ownerRuntimeInstanceId: 'runtime',
        contributionId: 'builtin.solid', layer: 'feature', priority: 1, value: { id: 'builtin.solid' } as RendererSuiteContribution,
      },
      kinds: new Map(kinds.map(kind => [kind.id, {
        ownerPluginId: 'core.renderer.execution', ownerRuntimeInstanceId: 'runtime',
        contributionId: kind.id, layer: 'feature', priority: kind.priority, value: kind,
      }])),
      slots: new Map(kinds.map(kind => [kind.id, [slotEntry]])),
      diagnostics: [],
    }
    mountSolidWorkbench({
      host, input: { sheetId: 'sheet-a', sessionId: 'preview-session' }, services, activation,
    })
    const make = (sequence: number, event: WorkbenchEventEnvelope['event']) => createWorkbenchEnvelope({
      sessionId: 'preview-session', sequence, recordedAt: `2026-08-23T00:01:0${sequence}.000Z`,
      source: { provider: 'hermes', sourceId: `c07-slot-${sequence}` },
      identity: event.type.startsWith('message.') ? { messageId: 'message-slot' } : { taskId: 'process-slot' },
      provenance: { origin: 'local-observed', trust: 'authoritative' }, event,
    })
    const workbenchDocument = projectWorkbench([
      make(1, { type: 'message.delta', role: 'assistant', parts: [
        { kind: 'terminal', streams: [{ stream: 'stdout', text: 'slot terminal' }] },
        { kind: 'log', entries: [{ level: 'info', text: 'slot log' }] },
      ] }),
      make(2, { type: 'activity.started', activityId: 'process-slot', activity: {
        kind: 'process', semanticKind: 'activity.process', title: 'slot process', processId: 'pid-slot',
      } }),
    ]).document
    services.runtime.replaceDocument(workbenchDocument, { ownerKey: 'owner-preview', generation: 1 })

    await waitFor(() => expect(host.querySelector('[data-renderer-slot-id="builtin.solid.content.base"] .term-terminal-card')).toHaveTextContent('slot terminal'))
    expect(host.querySelector('[data-renderer-slot-id="builtin.solid.content.base"] .term-log-card')).toHaveTextContent('slot log')
    expect(host.querySelector('[data-renderer-slot-id="builtin.solid.content.base"] .term-process-activity')).toHaveTextContent('slot process')
  })

  it('canonical reasoning terminal metadata reaches the production content Slot', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    hosts.push(host)
    const services = createPreviewWorkbenchServices()
    servicesList.push(services)
    const slot = createBuiltinSolidContentSlot()
    const slotEntry = {
      ownerPluginId: 'builtin.pylon-renderers', ownerRuntimeInstanceId: 'runtime',
      contributionId: slot.id, layer: 'feature', priority: slot.priority, value: slot,
    } as RegistryEntry<RendererSlotContribution>
    const kindEntries = BUILTIN_TEXT_RENDER_KINDS
      .filter(kind => kind.id === 'content.reasoning' || kind.id === 'content.redacted-reasoning')
      .map(kind => [kind.id, {
        ownerPluginId: 'core.renderer.text-kinds', ownerRuntimeInstanceId: 'runtime',
        contributionId: kind.id, layer: 'feature', priority: kind.priority, value: kind,
      } as RegistryEntry<(typeof BUILTIN_TEXT_RENDER_KINDS)[number]>] as const)
    const suite = { id: 'builtin.solid' } as RendererSuiteContribution
    const activation: RendererActivationSnapshot = {
      revision: 1,
      suite: {
        ownerPluginId: 'builtin.pylon-renderers', ownerRuntimeInstanceId: 'runtime',
        contributionId: suite.id, layer: 'feature', priority: 1, value: suite,
      } as RegistryEntry<RendererSuiteContribution>,
      kinds: new Map(kindEntries),
      slots: new Map([
        ['content.reasoning', [slotEntry]],
        ['content.redacted-reasoning', [slotEntry]],
      ]),
      diagnostics: [],
    }
    mountSolidWorkbench({
      host,
      input: { sheetId: 'sheet-a', sessionId: 'preview-session' },
      services,
      activation,
    })
    const envelope = (
      sequence: number,
      event: WorkbenchEventEnvelope['event'],
      messageId: string,
      occurredAt: string,
    ) => createWorkbenchEnvelope({
      sessionId: 'preview-session', sequence, recordedAt: occurredAt, occurredAt,
      source: { provider: 'claude', sourceId: `reasoning-${sequence}` },
      identity: { messageId },
      provenance: { origin: 'local-observed', trust: 'authoritative' }, event,
    })
    const projected = projectWorkbench([
      envelope(1, { type: 'reasoning.delta', parts: [{ kind: 'reasoning', text: 'visible thought' }] }, 'thought-visible', '2026-08-21T00:00:01.000Z'),
      envelope(2, { type: 'reasoning.completed', parts: [] }, 'thought-visible', '2026-08-21T00:00:03.400Z'),
      envelope(3, { type: 'reasoning.redacted', parts: [{ kind: 'redacted-reasoning', reason: 'provider_policy' }], reason: 'provider_policy' }, 'thought-redacted', '2026-08-21T00:00:04.000Z'),
    ]).document

    services.runtime.replaceDocument(projected, { ownerKey: 'owner-preview', generation: 1 })

    expect(await screen.findByRole('button', { name: /Thought for 2\.4s/ })).toBeTruthy()
    expect(await screen.findByText('provider_policy')).toBeTruthy()
    expect(host.querySelector('[data-content-kind="content.reasoning"]')).not.toBeNull()
    expect(host.querySelector('[data-content-kind="content.redacted-reasoning"]')).not.toBeNull()
  })

  it('keeps C02 documents visible through the built-in no-Slot fallback', async () => {
    const { host, services } = mountPreview()
    const projected = projectWorkbench([createWorkbenchEnvelope({
      sessionId: 'preview-session', sequence: 1,
      recordedAt: '2026-08-22T00:00:01.000Z', occurredAt: '2026-08-22T00:00:01.000Z',
      source: { provider: 'peri', sourceId: 'document-fallback' }, identity: { messageId: 'document-fallback' },
      provenance: { origin: 'local-observed', trust: 'authoritative' },
      event: {
        type: 'message.delta', role: 'assistant',
        parts: [{ kind: 'document', title: 'fallback-spec.md', text: 'fallback document body', mimeType: 'text/markdown' }],
      },
    })]).document

    services.runtime.replaceDocument(projected, { ownerKey: 'owner-preview', generation: 1 })

    expect(await screen.findByText('fallback-spec.md')).toBeTruthy()
    expect(await screen.findByText('fallback document body')).toBeTruthy()
    expect(host.querySelector('[data-part-kind="document"]')).not.toBeNull()
    expect(host.textContent).not.toContain('Unsupported content kind: document')
  })

  it('interaction 只提交 normalized optionId，不自造 provider approval payload', async () => {
    const { services } = mountPreview({ interactionResponse: true })
    const document = projectWorkbench([createWorkbenchEnvelope({
      sessionId: 'preview-session', recordedAt: '2026-08-21T00:00:01.000Z', sequence: 1,
      source: { provider: 'peri', sourceId: 'interaction-1' }, identity: { interactionId: 'interaction-1' },
      provenance: { origin: 'local-observed', trust: 'authoritative' },
      event: {
        type: 'interaction.requested', interactionId: 'interaction-1',
        request: {
          surface: 'interaction', kind: 'approval', state: 'waiting',
          identity: { provider: 'peri', agentId: 'peri', requestId: 'request-1', sessionId: 'preview-session', clientGeneration: 3 },
          questions: [{ id: 'approval', question: 'Allow edit?', allowMultiple: false, allowFreeform: false,
            options: [{ id: 'allow_once', label: 'Allow once' }, { id: 'reject_once', label: 'Reject' }] }],
        },
      },
    })]).document
    services.runtime.replaceDocument(document, { ownerKey: 'owner-preview', generation: 1 })
    const allowButton = await screen.findByRole('button', { name: 'Allow once' })
    expect(allowButton.closest('.interaction-card')).not.toBeNull()

    fireEvent.click(allowButton)

    await waitFor(() => expect(services.commands.calls).toContainEqual({
      // A09 补全：按钮随响应携带 expectedRevision（document.sequence）供 transport 层 stale 防护
      command: 'respondInteraction', args: ['preview-session', 'interaction-1', { optionId: 'allow_once' }, { expectedRevision: 1 }],
    }))
  })

  it('interaction command failure keeps the answer editable and reports the rejection', async () => {
    const { services } = mountPreview({ interactionResponse: true })
    services.commands.setHandler('respondInteraction', async () => ({ ok: false, error: 'policy denied' }))
    services.runtime.replaceDocument(projectWorkbench([createWorkbenchEnvelope({
      sessionId: 'preview-session', recordedAt: '2026-08-21T00:00:01.000Z', sequence: 2,
      source: { provider: 'peri', sourceId: 'interaction-failure' }, identity: { interactionId: 'interaction-failure' },
      provenance: { origin: 'local-observed', trust: 'authoritative' },
      event: {
        type: 'interaction.requested', interactionId: 'interaction-failure',
        request: {
          surface: 'interaction', kind: 'ask-question', state: 'waiting',
          identity: { provider: 'peri', agentId: 'peri', requestId: 'request-failure', sessionId: 'preview-session', clientGeneration: 3 },
          questions: [{ id: 'reason', question: '为什么继续？', allowMultiple: false, allowFreeform: true, options: [] }],
        },
      },
    })]).document, { ownerKey: 'owner-preview', generation: 1 })

    const input = await screen.findByPlaceholderText('输入回答后回车') as HTMLInputElement
    fireEvent.input(input, { target: { value: '仍需完成验证' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(await screen.findByRole('alert')).toHaveTextContent('policy denied')
    expect(input).toHaveValue('仍需完成验证')
  })

  it('routes canonical interactions through a Suite-local replaceable Slot', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    hosts.push(host)
    const services = createPreviewWorkbenchServices()
    servicesList.push(services)
    const kind = BUILTIN_INTERACTION_RENDER_KINDS.find(item => item.id === 'interaction.approval')!
    const slot: RendererSlotContribution = {
      id: 'plugin.interaction.approval', targetSuites: ['builtin.solid'], kinds: [kind.id], priority: 20_000,
      fallback: false, canRender: () => true,
      createSurface: () => ({
        rendererId: 'plugin.interaction.approval', kind: 'solid',
        mount(container) {
          const node = document.createElement('div')
          node.textContent = 'Plugin approval surface'
          container.append(node)
          return node
        },
        update() {}, destroy(handle) { (handle as HTMLElement).remove() }, on: () => () => {},
      }),
    }
    const suite = { id: 'builtin.solid' } as RendererSuiteContribution
    const kindEntry = { ownerPluginId: 'core.interaction', ownerRuntimeInstanceId: 'runtime', contributionId: kind.id,
      layer: 'feature', priority: kind.priority, value: kind } as RegistryEntry<typeof kind>
    const slotEntry = { ownerPluginId: 'plugin.interaction', ownerRuntimeInstanceId: 'runtime', contributionId: slot.id,
      layer: 'feature', priority: slot.priority, value: slot } as RegistryEntry<RendererSlotContribution>
    const activation: RendererActivationSnapshot = {
      revision: 1,
      suite: { ownerPluginId: 'builtin.pylon-renderers', ownerRuntimeInstanceId: 'runtime', contributionId: suite.id,
        layer: 'feature', priority: 1, value: suite } as RegistryEntry<RendererSuiteContribution>,
      kinds: new Map([[kind.id, kindEntry]]), slots: new Map([[kind.id, [slotEntry]]]), diagnostics: [],
    }
    mountSolidWorkbench({ host, input: { sheetId: 'sheet-a', sessionId: 'preview-session' }, services, activation })
    services.runtime.replaceDocument(projectWorkbench([createWorkbenchEnvelope({
      sessionId: 'preview-session', recordedAt: '2026-08-21T00:00:01.000Z', sequence: 1,
      source: { provider: 'peri', sourceId: 'replaceable-interaction' }, identity: { interactionId: 'replaceable-interaction' },
      provenance: { origin: 'local-observed', trust: 'authoritative' },
      event: {
        type: 'interaction.requested', interactionId: 'replaceable-interaction',
        request: { surface: 'interaction', kind: 'approval', state: 'waiting',
          identity: { provider: 'peri', agentId: 'peri', requestId: 'replaceable', sessionId: 'preview-session', clientGeneration: 1 },
          questions: [{ id: 'approval', question: 'Replace me?', allowMultiple: false, allowFreeform: false, options: [] }] },
      },
    })]).document, { ownerKey: 'owner-preview', generation: 1 })

    expect(await screen.findByText('Plugin approval surface')).toBeTruthy()
    expect(host.querySelector('.interaction-card')).toBeNull()
  })

  it('gives a C12 plugin replacement only the redacted canonical interaction snapshot', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    hosts.push(host)
    const services = createPreviewWorkbenchServices()
    servicesList.push(services)
    const kind = BUILTIN_INTERACTION_RENDER_KINDS.find(item => item.id === 'interaction.secret')!
    let pluginSnapshot = ''
    const slot: RendererSlotContribution = {
      id: 'plugin.interaction.secret', targetSuites: ['builtin.solid'], kinds: [kind.id], priority: 20_000,
      fallback: false, canRender: () => true,
      createSurface: () => ({
        rendererId: 'plugin.interaction.secret', kind: 'solid',
        mount(container, snapshot) {
          pluginSnapshot = JSON.stringify(snapshot)
          const node = document.createElement('div')
          node.textContent = 'Plugin secret surface'
          container.append(node)
          return node
        },
        update(_handle, snapshot) { pluginSnapshot = JSON.stringify(snapshot) },
        destroy(handle) { (handle as HTMLElement).remove() }, on: () => () => {},
      }),
    }
    const suite = { id: 'builtin.solid' } as RendererSuiteContribution
    const kindEntry = { ownerPluginId: 'core.interaction', ownerRuntimeInstanceId: 'runtime', contributionId: kind.id,
      layer: 'feature', priority: kind.priority, value: kind } as RegistryEntry<typeof kind>
    const slotEntry = { ownerPluginId: 'plugin.interaction', ownerRuntimeInstanceId: 'runtime', contributionId: slot.id,
      layer: 'feature', priority: slot.priority, value: slot } as RegistryEntry<RendererSlotContribution>
    const activation: RendererActivationSnapshot = {
      revision: 1,
      suite: { ownerPluginId: 'builtin.pylon-renderers', ownerRuntimeInstanceId: 'runtime', contributionId: suite.id,
        layer: 'feature', priority: 1, value: suite } as RegistryEntry<RendererSuiteContribution>,
      kinds: new Map([[kind.id, kindEntry]]), slots: new Map([[kind.id, [slotEntry]]]), diagnostics: [],
    }
    mountSolidWorkbench({ host, input: { sheetId: 'sheet-a', sessionId: 'preview-session' }, services, activation })
    const credential = 'c12-plugin-secret'
    services.runtime.replaceDocument(projectWorkbench([createWorkbenchEnvelope({
      sessionId: 'preview-session', recordedAt: '2026-08-21T00:00:01.000Z', sequence: 1,
      source: { provider: 'peri', sourceId: 'replaceable-secret' }, identity: { interactionId: 'replaceable-secret' },
      provenance: { origin: 'local-observed', trust: 'authoritative' },
      event: {
        type: 'interaction.requested', interactionId: 'replaceable-secret',
        request: { surface: 'interaction', kind: 'secret', state: 'waiting', value: credential,
          identity: { provider: 'peri', agentId: 'peri', requestId: 'secret-1', sessionId: 'preview-session', toolCallId: null, clientGeneration: 1 },
          questions: [{ id: 'secret', question: 'Credential', allowMultiple: false, allowFreeform: true, options: [] }] },
      },
    })]).document, { ownerKey: 'owner-preview', generation: 1 })

    expect(await screen.findByText('Plugin secret surface')).toBeTruthy()
    expect(pluginSnapshot).not.toContain(credential)
    expect(pluginSnapshot).toContain('valueRedacted')
  })

  it('Slot semantic action 穿过 Host command capability gate，不被 lifecycle 静默丢弃', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    hosts.push(host)
    const services = createPreviewWorkbenchServices()
    servicesList.push(services)
    const hostPort = createWorkbenchHostPort({
      ...services, suiteId: 'builtin.solid', sheetId: 'sheet-a',
      sessionOwnerKey: 'owner-a', sessionId: 'preview-session',
      capabilities: { clipboardWrite: true },
    })
    const slot: RendererSlotContribution = {
      id: 'test.semantic-action', targetSuites: ['builtin.solid'], kinds: ['message.assistant'],
      priority: 1, fallback: false, canRender: () => true,
      createSurface: () => ({
        rendererId: 'test.semantic-action', kind: 'solid',
        mount(container, _snapshot, _appearance, commands) {
          const button = document.createElement('button')
          button.textContent = 'copy through semantic port'
          button.addEventListener('click', () => { void commands.execute({ type: 'clipboard.write', payload: { text: 'semantic copy' } }) })
          container.append(button)
          return button
        },
        update() {}, destroy(handle) { (handle as HTMLElement).remove() }, on: () => () => {},
      }),
    }
    const entry = { ownerPluginId: 'test.semantic-action', ownerRuntimeInstanceId: 'runtime', contributionId: slot.id, layer: 'feature', priority: 1, value: slot } as RegistryEntry<RendererSlotContribution>
    const suite = { id: 'builtin.solid' } as RendererSuiteContribution
    const activation = {
      revision: 1,
      suite: { ownerPluginId: 'builtin.pylon-renderers', ownerRuntimeInstanceId: 'runtime', contributionId: 'builtin.solid', layer: 'feature', priority: 1, value: suite } as RegistryEntry<RendererSuiteContribution>,
      kinds: new Map(), slots: new Map([['message.assistant', [entry]]]), diagnostics: [],
    } as RendererActivationSnapshot
    mountSolidWorkbench({
      host, input: { sheetId: 'sheet-a', sessionId: 'preview-session' }, services, hostPort, activation,
    })

    // The preview fixture carries multiple assistant rows, so the custom Slot
    // mounts one button per row; any of them routes through the same port.
    const semanticButtons = await screen.findAllByRole('button', { name: 'copy through semantic port' })
    fireEvent.click(semanticButtons[0]!)

    await waitFor(() => expect(services.commands.calls).toContainEqual({
      command: 'copy', args: ['preview-session', 'semantic copy'],
    }))
  })
})
