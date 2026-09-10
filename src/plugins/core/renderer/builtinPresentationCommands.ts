import type { CommandDefinition } from '../../../plugin-runtime/commands/commandRegistry.ts'
import { getPresentationProfileRegistry } from '../../../plugin-runtime/runtimeServices.ts'
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
    { id: 'presentation.apply', name: 'presentation.apply', description: '应用呈现风格，不重置背景和用户资产', priority: base + 2, execute: ({ args }) => { const profileId = id(record(args).profileId, 'profileId'); const entry = getPresentationProfileRegistry().resolve(profileId); if (!entry) throw new Error(`呈现风格不存在：${profileId}`); const result = applyPresentationProfile(entry.value, { setZoneField: (zone, patch, source) => useStore.getState().setZoneField(zone, patch, source), setActiveProfileId: next => usePresentationPreferenceStore.getState().setActiveProfileId(next) }); if (result.status === 'failed') throw new Error(result.message); return { profileId, result } } },
  ]
}
