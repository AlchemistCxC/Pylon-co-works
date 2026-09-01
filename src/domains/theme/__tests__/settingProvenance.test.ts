// @vitest-environment jsdom
// D-trace：设置项写入溯源——漏斗挂钩与贡献者区分（呈现风格 vs 用户编辑）。
import { beforeEach, describe, expect, it } from 'vitest'
import { useStore } from '../../../store.ts'
import { resetStores } from '../../../test/resetStores.ts'
import {
  lastSettingWriter,
  recentSettingWrites,
  recordSettingWrites,
  resetSettingProvenance,
  SETTING_WRITE_SOURCE_LABELS,
} from '../settingProvenance.ts'
import { applyPresentationProfile } from '../../../application/transactions/applyPresentationProfile.ts'
import type { PresentationProfileContribution } from '../../../plugin-runtime/presentation/presentationProfileTypes.ts'

describe('setting provenance ledger', () => {
  beforeEach(() => {
    localStorage.clear()
    resetStores()
    resetSettingProvenance()
  })

  it('attributes user edits through the setZoneField funnel', () => {
    useStore.getState().setZoneField('chat', { chatFontSize: 19 })
    expect(lastSettingWriter('chatFontSize')).toMatchObject({ source: 'user-edit', zone: 'chat' })
  })

  it('distinguishes presentation-profile token writes from user edits', () => {
    const profile = {
      id: 'builtin.presentation.test-trace',
      label: '溯源测试',
      interfaceMode: 'terminal-like',
      tokens: { chatFontSize: 16, chatFont: 'serif' },
    } as unknown as PresentationProfileContribution
    applyPresentationProfile(profile, {
      setZoneField: (zone, patch, source) => useStore.getState().setZoneField(zone, patch, source),
      setActiveProfileId: () => {},
    })
    expect(lastSettingWriter('chatFontSize')).toMatchObject({ source: 'presentation-profile' })
    expect(useStore.getState().chatFontSize).toBe(16)

    // 用户随后手改 → 贡献者被覆盖为 user-edit（last-writer-wins）
    useStore.getState().setZoneField('chat', { chatFontSize: 21 })
    expect(lastSettingWriter('chatFontSize')).toMatchObject({ source: 'user-edit' })
    expect(useStore.getState().chatFontSize).toBe(21)
  })

  it('records preset and reset actions with their own sources', () => {
    useStore.getState().setZoneField('chat', { chatFontSize: 18 })
    useStore.getState().setGlobalPreset('nord', {})
    expect(lastSettingWriter('chatFontSize')?.source).toBe('global-preset')

    useStore.getState().setZoneField('chat', { chatFontSize: 18 })
    useStore.getState().resetZone('chat')
    expect(lastSettingWriter('chatFontSize')?.source).toBe('zone-reset')

    useStore.getState().setZoneField('chat', { chatFontSize: 18 })
    useStore.getState().resetTheme()
    expect(lastSettingWriter('chatFontSize')?.source).toBe('theme-reset')
  })

  it('keeps a bounded ring buffer (newest first)', () => {
    for (let index = 0; index < 300; index += 1) {
      recordSettingWrites('user-edit', 'chat', ['chatFontSize'], index)
    }
    const recent = recentSettingWrites(10)
    expect(recent).toHaveLength(10)
    expect(recent[0]).toMatchObject({ at: 299 })
    expect(recent[9]).toMatchObject({ at: 290 })
  })

  it('exposes localized source labels for every source', () => {
    for (const label of Object.values(SETTING_WRITE_SOURCE_LABELS)) {
      expect(label.trim().length).toBeGreaterThan(0)
    }
  })
})
