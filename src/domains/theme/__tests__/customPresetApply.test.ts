// @vitest-environment jsdom
// D-fix 回归：自定义预设"切换后未生效"——store 级应用链路（v2 bundle 提交 +
// 静默失败可见化）。三段：正常应用、持久化往返后应用、失效 id 必须可见报告。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useStore } from '../../../store.ts'
import { resetStores } from '../../../test/resetStores.ts'
import { THEME_SCHEMA_VERSION, themeDomainMigrate } from '../migration.ts'

function snapshotState() {
  const state = useStore.getState()
  return JSON.parse(JSON.stringify({
    theme: Object.fromEntries([
      'chatFontSize', 'chatFont', 'toolIndicator', 'toolIndicatorRun', 'toolIndicatorOk',
      'toolIndicatorErr', 'assistantDot', 'assistantDotGlyph', 'appliedPreset', 'custom',
      'customPresets', 'ccHeight', 'ccBgHeight',
    ].map(key => [key, (state as unknown as Record<string, unknown>)[key]])),
  }))
}

describe('custom preset apply (D-fix)', () => {
  beforeEach(() => {
    localStorage.clear()
    resetStores()
  })

  it('applies the saved theme delta back when switching to a custom preset', () => {
    const store = useStore.getState()
    store.setZoneField('chat', {
      chatFontSize: 19,
      toolIndicatorRun: 'star',
      toolIndicatorOk: 'check',
      toolIndicatorErr: 'cross',
      assistantDot: true,
      assistantDotGlyph: '◆',
    })
    const id = store.saveCustomPreset('指示器回归')

    // 漂移现场：改字段 + 应用一个内置全局预设（与真实"切换"路径一致）
    useStore.getState().setZoneField('chat', { chatFontSize: 12, assistantDotGlyph: '■' })
    useStore.getState().setGlobalPreset('nord', { chatFontSize: 14 })

    useStore.getState().applyCustomPreset(id)

    const state = useStore.getState()
    expect(state.chatFontSize).toBe(19)
    expect(state.toolIndicatorRun).toBe('star')
    expect(state.toolIndicatorOk).toBe('check')
    expect(state.toolIndicatorErr).toBe('cross')
    expect(state.assistantDot).toBe(true)
    expect(state.assistantDotGlyph).toBe('◆')
    expect(state.appliedPreset.chat).toBe(id)
    expect(state.appliedPreset.global).toBe(id)
    expect(state.custom.chat).toBe(false)
  })

  it('applies after a persistence roundtrip (localStorage rehydrate + migrate)', () => {
    const store = useStore.getState()
    store.setZoneField('chat', { chatFontSize: 20, toolIndicatorRun: 'hourglass' })
    const id = store.saveCustomPreset('往返回归')

    const persisted = JSON.parse(JSON.stringify(useStore.getState()))
    const migrated = themeDomainMigrate(persisted, {
      base: useStore.getState(),
      appliedPreset: { global: '', sidebar: '', chat: '', cc: '', right: '' },
      custom: { global: false, sidebar: false, chat: false, cc: false, right: false },
      ccLayout: useStore.getState().ccLayout,
    }, THEME_SCHEMA_VERSION) as Record<string, unknown>

    // 模拟重放水后的 store：customPresets 来自迁移产物
    useStore.setState({ customPresets: migrated.customPresets as never })
    useStore.getState().setZoneField('chat', { chatFontSize: 12 })

    useStore.getState().applyCustomPreset(id)
    expect(useStore.getState().chatFontSize).toBe(20)
    expect(useStore.getState().toolIndicatorRun).toBe('hourglass')
    expect(useStore.getState().appliedPreset.chat).toBe(id)
  })

  it('reports a missing custom preset id instead of failing silently', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const before = snapshotState()
      useStore.getState().applyCustomPreset('custom-does-not-exist')
      expect(spy).toHaveBeenCalled()
      expect(snapshotState()).toEqual(before)
    } finally {
      spy.mockRestore()
    }
  })
})
