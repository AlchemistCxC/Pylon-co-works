// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from '@solidjs/testing-library'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mountSolidWorkbench } from '../mountSolidWorkbench.solid.tsx'
import { createPreviewWorkbenchServices } from '../__fixtures__/previewWorkbenchServices.ts'
import { createWorkbenchEnvelope, type WorkbenchEventEnvelope } from '../../../domains/workbench/events/workbenchEventSchema.ts'
import { projectWorkbench, reduceWorkbenchEvent } from '../../../domains/workbench/workbenchProjector.ts'
import { createWorkbenchHostPort } from '../workbenchHostPort.ts'
import { RendererSuiteHost } from '../../../host/renderer-suite/rendererSuiteHost.ts'
import type { RendererActivationSnapshot, RendererSlotContribution, RendererSuiteContribution } from '../../../plugin-runtime/renderers/rendererSuiteTypes.ts'
import type { RegistryEntry } from '../../../plugin-runtime/registry/types.ts'
import { BUILTIN_TEXT_RENDER_KINDS } from '../../../domains/rendererContent/textRenderKindCatalog.ts'
import { BUILTIN_TOOL_RENDER_KINDS } from '../../../domains/rendererContent/toolRenderKindCatalog.ts'
import { createBuiltinSolidContentSlot } from '../builtinSolidRendererSuite.ts'

const hosts: HTMLElement[] = []
const servicesList: ReturnType<typeof createPreviewWorkbenchServices>[] = []

afterEach(() => {
  cleanup()
  for (const services of servicesList.splice(0)) services.destroy()
  for (const host of hosts.splice(0)) host.remove()
})

function mountPreview() {
  const host = document.createElement('div')
  document.body.append(host)
  hosts.push(host)
  const services = createPreviewWorkbenchServices()
  servicesList.push(services)
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
  })
  return { host, services, lifecycle }
}

describe('mountSolidWorkbench', () => {
  it('挂载完整 fixture shell，复用 Message/Tool/Task/Generation renderer', async () => {
    const { host } = mountPreview()

    expect(screen.getByLabelText('Solid Agent Workbench')).toBeTruthy()
    expect(host.querySelector('[data-renderer="solid"]')?.getAttribute('data-preview')).toBe('true')
    expect(await screen.findByRole('heading', { name: '迁移结果' }, { timeout: 5_000 })).toBeTruthy()
    expect(screen.getByText('Read')).toBeTruthy()
    expect(host.querySelector('.task-tree')).toBeTruthy()
    expect(host.querySelector('.term-spinner')).toBeTruthy()
    expect(host.querySelector('.control-center')?.getAttribute('data-fixture')).toBe('widgets')
    expect(host.querySelector('.pet-companion')?.getAttribute('data-fixture')).toBe('pending')
    await waitFor(() => expect(host.querySelectorAll('.plain-message-list__row').length).toBeGreaterThan(0))
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
    expect(host.firstElementChild?.getAttribute('style')).toContain('80px')

    lifecycle.update({ sheetId: 'sheet-a', sessionId: null, preview: true })
    await waitFor(() => expect(screen.getByText('选择或创建一个 Session')).toBeTruthy())
    expect(host.firstElementChild).toBe(root)
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

  it('document apply 驱动消息、活动、usage 与 diagnostics surface', async () => {
    const { host, services } = mountPreview()
    const envelope = (sequence: number, event: WorkbenchEventEnvelope['event']): WorkbenchEventEnvelope => createWorkbenchEnvelope({
      sessionId: 'preview-session', recordedAt: `2026-08-21T00:00:0${sequence}.000Z`, sequence,
      source: { provider: 'peri', sourceId: `solid-${sequence}` }, provenance: { origin: 'local-observed', trust: 'authoritative' }, event,
    })
    const document = projectWorkbench([
      envelope(1, { type: 'message.delta', role: 'assistant', parts: [{ kind: 'text', text: 'canonical answer' }] }),
      envelope(2, { type: 'tool.started', tool: { toolCallId: 'tool-1', name: 'Read', status: 'running' } }),
      envelope(3, { type: 'usage.updated', usage: { inputTokens: 8 } }),
      envelope(4, { type: 'diagnostic.notice', level: 'warning', code: 'demo.warning', message: 'canonical warning' }),
    ]).document
    services.runtime.replaceDocument(document, { ownerKey: 'owner-preview', generation: 1 })
    await waitFor(() => expect(screen.getByText('canonical answer')).toBeTruthy())
    expect(host.querySelector('[data-activity-count="1"]')).toBeTruthy()
    expect(host.querySelector('[data-has-usage="true"]')).toBeTruthy()
    expect(screen.getByText('canonical warning')).toBeTruthy()
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
    expect(replacementCard).toBe(card)
    expect(replacementCard.querySelector('.term-tool-head')).toHaveAttribute('aria-controls', 'solid-tool-snapshot-tool-replacement')
    expect(replacementCard.querySelector('.term-tool-head')).toHaveAttribute('aria-expanded', 'true')
    expect(replacementCard.querySelector('#solid-tool-snapshot-tool-replacement')).not.toBeNull()
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
    const { services } = mountPreview()
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
    await waitFor(() => expect(screen.getByRole('button', { name: 'Allow once' })).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: 'Allow once' }))

    await waitFor(() => expect(services.commands.calls).toContainEqual({
      command: 'respondInteraction', args: ['preview-session', 'interaction-1', { optionId: 'allow_once' }],
    }))
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

    fireEvent.click(await screen.findByRole('button', { name: 'copy through semantic port' }))

    await waitFor(() => expect(services.commands.calls).toContainEqual({
      command: 'copy', args: ['preview-session', 'semantic copy'],
    }))
  })
})
