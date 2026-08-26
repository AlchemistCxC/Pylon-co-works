import { useEffect, useMemo, useRef, useState } from 'react'
import { createPreviewWorkbenchServices } from '../../renderers/solid-workbench/__fixtures__/previewWorkbenchServices.ts'
import { THEME_DEFAULTS } from '../../themeFieldDefs.ts'
import { THEME_SETTING_KEYS } from '../../themeFieldDefs.ts'
import { useStore } from '../../store.ts'
import { getPresentationProfileRegistry, getRendererSettingsStore } from '../../plugin-runtime/runtimeServices.ts'
import { usePresentationPreferenceStore } from '../../domains/presentation/presentationPreferenceStore.ts'
import { resolveProductionRenderAppearance } from '../../plugin-runtime/renderers/productionRenderAppearance.ts'
import type { RenderAppearanceSnapshot, RenderCommandPort, RenderNodeSnapshot, RenderSurface } from '../../contracts/messageRenderer.ts'
import type { RendererRegistrySnapshot } from '../../plugin-runtime/renderers/rendererRegistry.ts'
import type { RendererSettingsCatalogEntry } from './rendererSettingsCatalog.ts'

function contributionForEntry(entry: RendererSettingsCatalogEntry, catalog: RendererRegistrySnapshot) {
  if (entry.namespace === 'kind') return catalog.renderKinds.find(item => item.value.id === entry.id)?.value
  if (entry.namespace === 'suite') return catalog.rendererSuites.find(item => item.value.id === entry.id)?.value
  return catalog.rendererSlots.find(item => item.value.id === entry.id)?.value
}

function fixtureForKind(kind: string, catalog: RendererRegistrySnapshot): unknown {
  return catalog.renderKinds.find(item => item.value.id === kind)?.value.fixture ?? { text: `Fixture: ${kind}` }
}

const PREVIEW_KIND_PRIORITY: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'markdown-text': ['content.markdown', 'content.text', 'content.search-result', 'content.link'],
  'code-terminal': ['content.code', 'content.terminal', 'content.ansi', 'content.log', 'content.diff'],
  reasoning: ['content.reasoning', 'content.redacted-reasoning'],
  'tool-activity': ['tool.output', 'tool.progress', 'tool.error', 'tool.generic'],
  workflow: ['activity.workflow', 'activity.subagent', 'activity.process'],
  'files-resources': ['content.file-reference', 'content.document', 'content.image'],
  'interaction-diagnostic': ['interaction.questions', 'diagnostic.lsp', 'session.usage'],
})

type PreviewState = 'default' | 'running' | 'completed' | 'failed' | 'streaming'

function previewStates(kind: string): readonly { readonly id: PreviewState; readonly label: string }[] {
  if (kind.startsWith('tool.')) return [
    { id: 'running', label: '运行中' },
    { id: 'completed', label: '已完成' },
    { id: 'failed', label: '失败' },
  ]
  if (kind === 'content.reasoning' || kind === 'content.redacted-reasoning') return [
    { id: 'running', label: '思考中' },
    { id: 'completed', label: '已完成' },
  ]
  if (kind === 'content.text' || kind === 'content.markdown') return [
    { id: 'default', label: '静态' },
    { id: 'streaming', label: '流式' },
  ]
  return []
}

function previewPayload(kind: string, payload: unknown, state: PreviewState): { readonly payload: unknown; readonly streaming: boolean } {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { payload, streaming: state === 'streaming' }
  const value = payload as Record<string, unknown>
  if (kind.startsWith('tool.')) {
    if (state === 'running') return { payload: { ...value, status: 'running', result: undefined }, streaming: false }
    if (state === 'failed') return {
      payload: {
        ...value,
        status: 'failed',
        result: {
          status: 'failed',
          error: { userSummary: '预览工具失败', technicalMessage: 'preview failure', recoverability: 'none' },
        },
      },
      streaming: false,
    }
    if (state === 'completed') return {
      payload: {
        ...value,
        status: 'completed',
        result: { status: 'completed', parts: [{ kind: 'text', text: '预览工具输出已完成' }], durationMs: 420 },
      },
      streaming: false,
    }
  }
  if (kind === 'content.reasoning' || kind === 'content.redacted-reasoning') {
    return { payload: { ...value, state: state === 'running' ? 'running' : 'complete', durationMs: state === 'running' ? undefined : 3800 }, streaming: false }
  }
  return { payload, streaming: state === 'streaming' }
}

function pickPreviewKind(entry: RendererSettingsCatalogEntry, catalog: RendererRegistrySnapshot, activeSuiteId?: string): string {
  if (entry.namespace === 'kind') return entry.id
  const contribution = contributionForEntry(entry, catalog)
  const candidates = entry.namespace === 'suite'
    ? [...(contribution && 'requiredKinds' in contribution ? contribution.requiredKinds : []), ...(contribution && 'optionalKinds' in contribution ? contribution.optionalKinds ?? [] : [])]
    : [...(contribution && 'kinds' in contribution ? contribution.kinds : [])]
  const preferred = PREVIEW_KIND_PRIORITY[entry.placement.categoryId] ?? []
  const priority = new Map(preferred.map((kind, index) => [kind, index]))
  candidates.sort((left, right) => (priority.get(left) ?? preferred.length + 1) - (priority.get(right) ?? preferred.length + 1))
  const active = activeSuiteId ? catalog.rendererSuites.find(item => item.value.id === activeSuiteId)?.value : undefined
  const supported = active ? new Set([...active.requiredKinds, ...(active.optionalKinds ?? [])]) : undefined
  return candidates.find(kind => (!supported || supported.has(kind)) && catalog.renderKinds.some(item => {
    if (item.value.id !== kind) return false
    try { return item.value.validateInput(item.value.fixture) } catch { return false }
  }))
    ?? candidates.find(kind => catalog.renderKinds.some(item => item.value.id === kind))
    ?? 'content.unknown'
}

function pickSlot(kind: string, catalog: RendererRegistrySnapshot, activeSuiteId?: string, preferredSlotId?: string) {
  const candidates = catalog.rendererSlots.filter(entry => entry.value.kinds.includes(kind)
    && (!activeSuiteId || entry.value.targetSuites.includes('*') || entry.value.targetSuites.includes(activeSuiteId)))
  return candidates.find(entry => entry.value.id === preferredSlotId) ?? candidates[0]
}

function previewSuiteForEntry(entry: RendererSettingsCatalogEntry, catalog: RendererRegistrySnapshot, activeSuiteId?: string): string | undefined {
  if (entry.namespace === 'suite') return entry.id
  if (activeSuiteId) return activeSuiteId
  if (entry.namespace === 'slot') {
    const slot = catalog.rendererSlots.find(item => item.value.id === entry.id)?.value
    return slot?.targetSuites.find(suiteId => suiteId !== '*')
  }
  return undefined
}

export default function RendererSettingsPreview(props: {
  readonly entry?: RendererSettingsCatalogEntry
  readonly catalog: RendererRegistrySnapshot
  readonly activeSuiteId?: string
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [previewState, setPreviewState] = useState<PreviewState>('default')
  const profileId = usePresentationPreferenceStore(state => state.activeProfileId)
  const previewSuiteId = props.entry ? previewSuiteForEntry(props.entry, props.catalog, props.activeSuiteId) : undefined
  const previewKind = props.entry ? pickPreviewKind(props.entry, props.catalog, previewSuiteId) : ''
  const previewStateOptions = useMemo(() => previewStates(previewKind), [previewKind])
  const effectivePreviewState = previewStateOptions.some(option => option.id === previewState)
    ? previewState
    : previewStateOptions[0]?.id ?? 'default'

  useEffect(() => setPreviewState('default'), [previewKind, props.entry?.id])

  useEffect(() => {
    const host = hostRef.current
    if (!host || !props.entry) return
    const entry = props.entry
    setError(null)
    const services = createPreviewWorkbenchServices()
    const themeSnapshot = () => Object.fromEntries(THEME_SETTING_KEYS.map(key => [key, useStore.getState()[key]]))
    const hostAppearance = { ...THEME_DEFAULTS, ...themeSnapshot() } as unknown as typeof THEME_DEFAULTS
    services.appearance.setTheme(hostAppearance as unknown as Parameters<typeof services.appearance.setTheme>[0])
    let refreshSurface: () => void = () => {}
    const unsubscribeTheme = useStore.subscribe(() => {
      services.appearance.setTheme({ ...THEME_DEFAULTS, ...themeSnapshot() } as unknown as Parameters<typeof services.appearance.setTheme>[0])
      refreshSurface()
    })
    const activeSuite = props.catalog.rendererSuites.find(item => item.value.id === previewSuiteId)?.value
    const kind = previewKind
    const slot = pickSlot(kind, props.catalog, previewSuiteId, entry.namespace === 'slot' ? entry.id : undefined)
    if (!slot) {
      setError(`没有找到可渲染 ${kind} 的 Slot`)
      services.destroy()
      unsubscribeTheme()
      return
    }
    const variant = previewPayload(kind, fixtureForKind(kind, props.catalog), effectivePreviewState)
    const node: RenderNodeSnapshot = {
      nodeId: `settings-preview:${entry.namespace}:${entry.id}`,
      kind,
      revision: 1,
      payload: variant.payload,
      streaming: variant.streaming,
    }
    const profile = getPresentationProfileRegistry().resolve(profileId)?.value
    const resolvedAppearance: RenderAppearanceSnapshot = resolveProductionRenderAppearance({
      hostAppearance: services.appearance.getSnapshot(),
      catalog: props.catalog,
      settings: getRendererSettingsStore().getSnapshot(),
      suiteId: previewSuiteId ?? activeSuite?.id ?? '',
      slotId: slot.value.id,
      kind,
      profileKindTokens: profile?.kindTokens?.[kind],
    })
    const commands: RenderCommandPort = {
      execute: async command => {
        if (command.type === 'copy' && typeof command.payload === 'string') await services.commands.copy('preview-session', command.payload)
      },
      canExecute: () => false,
    }
    let surface: RenderSurface | undefined
    let handle: unknown
    let disposed = false
    try {
      surface = slot.value.createSurface(node)
      handle = surface.mount(host, node, resolvedAppearance, commands)
      const unsubscribeError = surface.on('error', payload => setError(payload instanceof Error ? payload.message : String(payload)))
      refreshSurface = () => {
        if (disposed || !surface) return
        try {
          const nextAppearance = resolveProductionRenderAppearance({
            hostAppearance: services.appearance.getSnapshot() as never,
            catalog: props.catalog,
            settings: getRendererSettingsStore().getSnapshot(),
            suiteId: previewSuiteId ?? activeSuite?.id ?? '',
            slotId: slot.value.id,
            kind,
            profileKindTokens: profile?.kindTokens?.[kind],
          })
          surface.update(handle, node, nextAppearance)
        } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
      }
      const unsubscribeSettings = getRendererSettingsStore().subscribe(refreshSurface)
      return () => {
        disposed = true
        unsubscribeError()
        unsubscribeSettings()
        try { surface?.destroy(handle) } catch { /* renderer owns cleanup */ }
        services.destroy()
        host.replaceChildren()
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
    return () => {
      disposed = true
      unsubscribeTheme()
      services.destroy()
      host.replaceChildren()
    }
  }, [effectivePreviewState, previewKind, previewSuiteId, props.catalog, props.entry, profileId])

  if (!props.entry) return <div className="renderer-settings-preview-empty">选择一个渲染对象查看真实示例。</div>
  return <div className="renderer-settings-preview">
    <div className="renderer-settings-preview-head"><span>实时示例 / {props.entry.namespace}</span><strong>{props.entry.label}</strong></div>
    {previewStateOptions.length > 0 && <div className="renderer-settings-preview-states" aria-label="预览状态">
      {previewStateOptions.map(option => <button key={option.id} type="button"
        className={effectivePreviewState === option.id ? 'active' : ''}
        aria-pressed={effectivePreviewState === option.id}
        onClick={() => setPreviewState(option.id)}>{option.label}</button>)}
    </div>}
    <div className="renderer-settings-preview-surface" ref={hostRef} aria-label={`${props.entry.label}真实预览`} />
    {error && <div className="renderer-settings-preview-error" role="alert">预览回退：{error}</div>}
    <small className="renderer-settings-preview-note">预览使用真实工作台示例与生产外观解析器；只读，不写入会话。</small>
  </div>
}
