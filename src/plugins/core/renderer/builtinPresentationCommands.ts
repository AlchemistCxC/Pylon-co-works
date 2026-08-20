import type { CommandDefinition } from '../../../plugin-runtime/commands/commandRegistry.ts'
import { getPresentationProfileRegistry, getRendererRegistry } from '../../../plugin-runtime/runtimeServices.ts'
import { applyPresentationProfile } from '../../../application/transactions/applyPresentationProfile.ts'
import { usePresentationPreferenceStore } from '../../../domains/presentation/presentationPreferenceStore.ts'
import { useStore } from '../../../store.ts'
import type { PresentationProfileRegistryEntry } from '../../../plugin-runtime/presentation/presentationProfileTypes.ts'

function record(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {} }
function id(value: unknown, key: string): string { if (typeof value !== 'string' || !value.trim()) throw new Error(`${key} 必须是非空字符串`); return value.trim() }
function profileDescriptor(entry: PresentationProfileRegistryEntry) {
  return { id: entry.contributionId, pluginId: entry.ownerPluginId, label: entry.value.label, description: entry.value.description, family: entry.value.family, order: entry.value.order, tokens: entry.value.tokens, assets: entry.value.assets }
}

export function createBuiltinPresentationCommandDefinitions(): CommandDefinition[] {
  const base = 500
  return [
    { id: 'presentation.list', name: 'presentation.list', description: '列出呈现风格插件贡献', priority: base, execute: () => getPresentationProfileRegistry().getSnapshot().entries.map(profileDescriptor) },
    { id: 'presentation.inspect', name: 'presentation.inspect', description: '读取呈现风格详情', priority: base + 1, execute: ({ args }) => { const profileId = id(record(args).profileId, 'profileId'); const entry = getPresentationProfileRegistry().resolve(profileId); if (!entry) throw new Error(`呈现风格不存在：${profileId}`); return profileDescriptor(entry) } },
    { id: 'presentation.apply', name: 'presentation.apply', description: '应用呈现风格，不重置背景和用户资产', priority: base + 2, execute: ({ args }) => { const profileId = id(record(args).profileId, 'profileId'); const entry = getPresentationProfileRegistry().resolve(profileId); if (!entry) throw new Error(`呈现风格不存在：${profileId}`); applyPresentationProfile(entry.value, { setZoneField: (zone, patch) => useStore.getState().setZoneField(zone, patch), setActiveProfileId: next => usePresentationPreferenceStore.getState().setActiveProfileId(next) }); return { profileId } } },
    { id: 'presentation.renderer.list', name: 'presentation.renderer.list', description: '列出消息渲染器', priority: base + 3, execute: () => getRendererRegistry().snapshot().messageRenderers.map(entry => ({ id: entry.contributionId, pluginId: entry.ownerPluginId, rendererId: entry.value.renderer.rendererId, priority: entry.value.priority, fallback: entry.value.fallback })) },
    { id: 'presentation.renderer.set', name: 'presentation.renderer.set', description: '设置消息渲染器（auto 或 renderer id）', priority: base + 4, execute: ({ args }) => { const rendererId = id(record(args).rendererId, 'rendererId'); if (rendererId !== 'auto' && !getRendererRegistry().snapshot().messageRenderers.some(entry => entry.contributionId === rendererId || entry.value.renderer.rendererId === rendererId)) throw new Error(`消息渲染器不存在：${rendererId}`); usePresentationPreferenceStore.getState().setMessageRendererId(rendererId); return { rendererId } } },
  ]
}
