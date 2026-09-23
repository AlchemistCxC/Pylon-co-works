import { describe, expect, it } from 'vitest'
import {
  deserializeSettingsSheetState,
  normalizeSettingsSheetState,
  serializeSettingsSheetState,
} from '../settingsSheetState.ts'

describe('settingsSheetState 编解码（#154 阶段 4）', () => {
  it('空/非法输入归一到默认外观 › 全局，不抛', () => {
    for (const raw of [undefined, null, 42, 'str', {}]) {
      expect(normalizeSettingsSheetState(raw)).toEqual({ domain: 'appearance', section: 'global', pluginPageId: null })
    }
  })

  it('domain-only 深链落到该域首个分区（normalizeSettingsIntent 契约透传）', () => {
    expect(normalizeSettingsSheetState({ domain: 'workspace' })).toEqual({ domain: 'workspace', section: 'window', pluginPageId: null })
  })

  it('LEGACY_SETTINGS_ROUTES 别名继续归一（深链契约零迁移）', () => {
    expect(normalizeSettingsSheetState({ domain: 'renderer', section: 'suite' })).toEqual({ domain: 'appearance', section: 'renderers', pluginPageId: null })
    expect(normalizeSettingsSheetState({ domain: 'plugins' })).toEqual({ domain: 'plugins', section: 'pluginManager', pluginPageId: null })
  })

  it('未知分区在 plugins 域保留为 pluginPageId，其余归回 global', () => {
    expect(normalizeSettingsSheetState({ domain: 'plugins', section: 'some-plugin-page' })).toEqual({
      domain: 'plugins', section: 'pluginManager', pluginPageId: 'some-plugin-page',
    })
    expect(normalizeSettingsSheetState({ section: 'nope' })).toEqual({ domain: 'appearance', section: 'global', pluginPageId: null })
  })

  it('agentId 与 rendererCategoryId 仅在非空时保留', () => {
    const full = normalizeSettingsSheetState({ domain: 'appearance', section: 'renderers', agentId: 'peri', rendererCategoryId: 'markdown-text' })
    expect(full).toEqual({ domain: 'appearance', section: 'renderers', pluginPageId: null, agentId: 'peri', rendererCategoryId: 'markdown-text' })
    expect(normalizeSettingsSheetState({ rendererCategoryId: '' })).toEqual({ domain: 'appearance', section: 'global', pluginPageId: null })
  })

  it('serialize/deserialize 幂等且等价（往返零漂移）', () => {
    const raw = { domain: 'plugins', section: 'pluginManager', pluginPageId: 'pylon-plugin-manager', agentId: 'peri' }
    const once = serializeSettingsSheetState(raw)
    expect(deserializeSettingsSheetState(serializeSettingsSheetState(once))).toEqual(once)
  })
})

describe('pluginPageId 显式清除语义（#274 导航被困回归）', () => {
  it('显式 null 是清除信号：归一输出恒含 pluginPageId（null）', () => {
    expect(normalizeSettingsSheetState({ domain: 'plugins', section: 'hookDiagnostics', pluginPageId: null })).toEqual({
      domain: 'plugins', section: 'hookDiagnostics', pluginPageId: null,
    })
  })

  it('serialize 剥除 null——落盘形状保持「无键 = 无插件页」（ADR-0013 老状态可读）', () => {
    expect(serializeSettingsSheetState({ domain: 'plugins', section: 'pluginManager', pluginPageId: null }))
      .toEqual({ domain: 'plugins', section: 'pluginManager' })
    // 字符串值照常落盘
    expect(serializeSettingsSheetState({ domain: 'plugins', section: 'pluginManager', pluginPageId: 'x' }))
      .toEqual({ domain: 'plugins', section: 'pluginManager', pluginPageId: 'x' })
  })

  it('#274 patch 序列回归：卡死状态经「显式 null」patch 可清除（模拟 patchSheetState 的 merge + serialize）', () => {
    // 卡死的 sheet 状态（旧构建产物形状：无键省略/null 不落盘）
    const stuck = { domain: 'plugins', section: 'pluginManager', pluginPageId: 'pylon-plugin-manager' }
    const current = deserializeSettingsSheetState(stuck)
    expect(current.pluginPageId).toBe('pylon-plugin-manager')
    // 侧栏点「Hook 诊断」：partial 携带显式 null，经「状态展开 + partial 合并」预归一
    const patch = normalizeSettingsSheetState({ ...current, section: 'hookDiagnostics', pluginPageId: null })
    expect(patch.pluginPageId).toBeNull()
    // store：{...current, ...partial} 浅合并 → null 覆盖旧值 → serialize 剥除
    const merged = serializeSettingsSheetState({ ...current, ...patch })
    expect('pluginPageId' in merged).toBe(false)
    expect(merged).toEqual({ domain: 'plugins', section: 'hookDiagnostics' })
  })

  it('深链命名贡献页时仍指向该页（清除语义不误伤贡献深链）', () => {
    const linked = normalizeSettingsSheetState({ domain: 'plugins', section: 'other-contribution' })
    expect(linked.pluginPageId).toBe('other-contribution')
    expect(serializeSettingsSheetState(linked)).toEqual({ domain: 'plugins', section: 'pluginManager', pluginPageId: 'other-contribution' })
  })
})
