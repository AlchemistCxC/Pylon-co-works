import { describe, expect, it } from 'vitest'
import { createPluginIdentity } from '../../pluginIdentity.ts'
import { PluginScope } from '../../pluginScope.ts'
import { PluginSettingsPageRegistry } from '../pluginSettingsRegistry.ts'
import { PluginSettingsStore } from '../pluginSettingsStore.ts'
import { createPluginSettingsApi } from '../pluginSettingsApi.ts'
import { PluginSettingOptionsRegistry, resolvePluginSettingOptions } from '../pluginSettingOptionsRegistry.ts'
import { normalizeThemeState } from '../../../themeFieldDefs.ts'

const BASE = [
  { value: 'terminal', label: '终端记录流' },
  { value: 'bubble', label: '对话气泡' },
]

describe('plugin setting option contributions', () => {
  it('按 Registry 顺序叠加新增、删除与修改，卸载后自动回退', async () => {
    const registry = new PluginSettingOptionsRegistry()
    const first = registry.register(createPluginIdentity('plugin.first', 'one'), {
      id: 'plugin.first.message-style', target: 'theme.msgStyle', order: 10,
      remove: ['terminal'],
      upsert: [{ value: 'bubble', label: '柔和气泡' }, { value: 'cards', label: '分层卡片' }],
    })
    const second = registry.register(createPluginIdentity('plugin.second', 'one'), {
      id: 'plugin.second.message-style', target: 'theme.msgStyle', order: 20,
      upsert: [{ value: 'bubble', label: '高密度气泡', disabled: true }],
    })

    expect(resolvePluginSettingOptions('theme.msgStyle', BASE, registry.getSnapshot().entries)).toEqual([
      expect.objectContaining({ value: 'bubble', label: '高密度气泡', disabled: true, contributionId: 'plugin.second.message-style' }),
      expect.objectContaining({ value: 'cards', label: '分层卡片', contributionId: 'plugin.first.message-style' }),
    ])

    await second.dispose()
    expect(resolvePluginSettingOptions('theme.msgStyle', BASE, registry.getSnapshot().entries)[0]).toMatchObject({ value: 'bubble', label: '柔和气泡' })
    await first.dispose()
    expect(resolvePluginSettingOptions('theme.msgStyle', BASE, registry.getSnapshot().entries)).toEqual(BASE)
  })

  it('拒绝未知主题字段、非候选型字段与空贡献', () => {
    const registry = new PluginSettingOptionsRegistry()
    const owner = createPluginIdentity('plugin.invalid', 'one')
    expect(() => registry.register(owner, { id: 'missing', target: 'theme.missing', upsert: [{ value: 'x' }] })).toThrow(/不存在/)
    expect(() => registry.register(owner, { id: 'number', target: 'theme.globalFontSize', upsert: [{ value: 'x' }] })).toThrow(/不支持/)
    expect(() => registry.register(owner, { id: 'empty', target: 'theme.msgStyle' })).toThrow(/不能为空/)
  })

  it('水合时保留插件 select 值，不要在 Registry 激活前悄悄改回默认', () => {
    expect(normalizeThemeState({ msgStyle: 'cards' }).msgStyle).toBe('cards')
    expect(normalizeThemeState({ msgStyle: 42 }).msgStyle).toBe('terminal')
  })

  it('绑定 PluginScope，并在热更新 shadow transaction 中原子替换与 revert', async () => {
    const registry = new PluginSettingOptionsRegistry()
    const pages = new PluginSettingsPageRegistry()
    const store = new PluginSettingsStore()
    const oldOwner = createPluginIdentity('plugin.theme', 'old')
    const scope = new PluginScope(oldOwner.key)
    const api = createPluginSettingsApi(pages, store, oldOwner, scope, undefined, registry)
    api.registerOptions({ id: 'plugin.theme.mode', target: 'theme.msgStyle', upsert: [{ value: 'cards', label: 'Old cards' }] })
    expect(registry.getSnapshot().entries).toHaveLength(1)

    const nextOwner = createPluginIdentity('plugin.theme', 'next')
    const transaction = registry.beginShadowTransaction(nextOwner, oldOwner.key)
    transaction.register({ id: 'plugin.theme.mode', target: 'theme.msgStyle', upsert: [{ value: 'cards', label: 'New cards' }] }, { contributionId: 'ignored' })
    transaction.commit()
    expect(resolvePluginSettingOptions('theme.msgStyle', BASE, registry.getSnapshot().entries).at(-1)?.label).toBe('New cards')
    transaction.revert()
    expect(resolvePluginSettingOptions('theme.msgStyle', BASE, registry.getSnapshot().entries).at(-1)?.label).toBe('Old cards')

    await scope.dispose()
    expect(registry.getSnapshot().entries).toEqual([])
  })
})
