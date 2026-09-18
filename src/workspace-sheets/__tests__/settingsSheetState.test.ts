import { describe, expect, it } from 'vitest'
import {
  deserializeSettingsSheetState,
  normalizeSettingsSheetState,
  serializeSettingsSheetState,
} from '../settingsSheetState.ts'

describe('settingsSheetState 编解码（#154 阶段 4）', () => {
  it('空/非法输入归一到默认外观 › 全局，不抛', () => {
    for (const raw of [undefined, null, 42, 'str', {}]) {
      expect(normalizeSettingsSheetState(raw)).toEqual({ domain: 'appearance', section: 'global' })
    }
  })

  it('domain-only 深链落到该域首个分区（normalizeSettingsIntent 契约透传）', () => {
    expect(normalizeSettingsSheetState({ domain: 'workspace' })).toEqual({ domain: 'workspace', section: 'window' })
  })

  it('LEGACY_SETTINGS_ROUTES 别名继续归一（深链契约零迁移）', () => {
    expect(normalizeSettingsSheetState({ domain: 'renderer', section: 'suite' })).toEqual({ domain: 'appearance', section: 'renderers' })
    expect(normalizeSettingsSheetState({ domain: 'plugins' })).toEqual({ domain: 'plugins', section: 'pluginManager' })
  })

  it('未知分区在 plugins 域保留为 pluginPageId，其余归回 global', () => {
    expect(normalizeSettingsSheetState({ domain: 'plugins', section: 'some-plugin-page' })).toEqual({
      domain: 'plugins', section: 'pluginManager', pluginPageId: 'some-plugin-page',
    })
    expect(normalizeSettingsSheetState({ section: 'nope' })).toEqual({ domain: 'appearance', section: 'global' })
  })

  it('agentId 与 rendererCategoryId 仅在非空时保留', () => {
    const full = normalizeSettingsSheetState({ domain: 'appearance', section: 'renderers', agentId: 'peri', rendererCategoryId: 'markdown-text' })
    expect(full).toEqual({ domain: 'appearance', section: 'renderers', agentId: 'peri', rendererCategoryId: 'markdown-text' })
    expect(normalizeSettingsSheetState({ rendererCategoryId: '' })).toEqual({ domain: 'appearance', section: 'global' })
  })

  it('serialize/deserialize 幂等且等价（往返零漂移）', () => {
    const raw = { domain: 'plugins', section: 'pluginManager', pluginPageId: 'pylon-plugin-manager', agentId: 'peri' }
    const once = serializeSettingsSheetState(raw)
    expect(deserializeSettingsSheetState(serializeSettingsSheetState(once))).toEqual(once)
  })
})
