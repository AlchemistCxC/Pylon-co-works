import type { CommandDefinition } from '../../../plugin-runtime/commands/commandRegistry.ts'
import { getPluginSettingsPageRegistry, getPluginSettingsStore } from '../../../plugin-runtime/runtimeServices.ts'
import type { PluginSettingValue } from '../../../plugin-runtime/settings/pluginSettingsTypes.ts'
import { THEME_SETTING_KEYS } from '../../../themeFieldDefs.ts'
import { useStore } from '../../../store.ts'
import { buildExportPayload, preflightImportPayload } from '../../../configExportImport.ts'

function record(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {} }
function text(value: unknown, key: string): string { if (typeof value !== 'string' || !value.trim()) throw new Error(`${key} 必须是非空字符串`); return value.trim() }

export function createBuiltinShellCommandDefinitions(): CommandDefinition[] {
  const base = 600
  return [
    { id: 'plugin-settings.pages', name: 'plugin-settings.pages', description: '列出插件设置页面贡献', priority: base, execute: () => getPluginSettingsPageRegistry().getSnapshot().entries.map(entry => ({ id: entry.contributionId, pluginId: entry.ownerPluginId, label: entry.value.label, description: entry.value.description, renderKind: entry.value.renderKind, order: entry.value.order })) },
    { id: 'plugin-settings.get', name: 'plugin-settings.get', description: '读取插件设置值；省略 key 返回该插件全部值', priority: base + 1, execute: ({ args }) => { const input = record(args); const pluginId = text(input.pluginId, 'pluginId'); return typeof input.key === 'string' ? { pluginId, key: input.key, value: getPluginSettingsStore().get(pluginId, input.key) } : { pluginId, values: getPluginSettingsStore().getSnapshot(pluginId) } } },
    { id: 'plugin-settings.set', name: 'plugin-settings.set', description: '写入插件命名空间设置值', permission: 'gate', priority: base + 2, execute: ({ args }) => { const input = record(args); const pluginId = text(input.pluginId, 'pluginId'); const key = text(input.key, 'key'); if (!('value' in input)) throw new Error('value 缺失'); getPluginSettingsStore().set(pluginId, key, input.value as PluginSettingValue); return { pluginId, key, value: getPluginSettingsStore().get(pluginId, key) } } },
    { id: 'plugin-settings.remove', name: 'plugin-settings.remove', description: '删除插件命名空间设置值', permission: 'gate', priority: base + 3, execute: ({ args }) => { const input = record(args); const pluginId = text(input.pluginId, 'pluginId'); const key = text(input.key, 'key'); getPluginSettingsStore().remove(pluginId, key); return { pluginId, key, removed: true } } },
    { id: 'theme.inspect', name: 'theme.inspect', description: '读取当前主题/视觉设置', priority: base + 4, execute: () => { const state = useStore.getState(); return Object.fromEntries(THEME_SETTING_KEYS.map(key => [key, state[key]])) } },
    { id: 'theme.patch', name: 'theme.patch', description: '按 zone 修改主题字段', permission: 'gate', priority: base + 5, execute: ({ args }) => { const input = record(args); const zone = text(input.zone, 'zone'); const patch = record(input.patch); useStore.getState().setZoneField(zone, patch); return { zone, patch } } },
    { id: 'theme.reset-zone', name: 'theme.reset-zone', description: '重置一个主题 zone', permission: 'gate', priority: base + 6, execute: ({ args }) => { const zone = text(record(args).zone, 'zone'); useStore.getState().resetZone(zone); return { zone, reset: true } } },
    { id: 'theme.reset', name: 'theme.reset', description: '重置全部主题设置', permission: 'gate', priority: base + 7, execute: () => { useStore.getState().resetTheme(); return { reset: true } } },
    { id: 'config.export', name: 'config.export', description: '导出当前本地配置 envelope', priority: base + 8, execute: () => ({ payload: buildExportPayload(localStorage) }) },
    { id: 'config.import.preflight', name: 'config.import.preflight', description: '预检 Pylon 配置 envelope，不写入', priority: base + 9, execute: ({ args }) => preflightImportPayload(text(record(args).payload, 'payload')) },
  ]
}
