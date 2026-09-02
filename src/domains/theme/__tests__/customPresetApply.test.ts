// @vitest-environment jsdom
// D-fix 回归：自定义预设"切换后未生效"——store 级应用链路（v2 bundle 提交 +
// 静默失败可见化）。三段：正常应用、持久化往返后应用、失效 id 必须可见报告。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useStore } from '../../../store.ts'
import { resetStores } from '../../../test/resetStores.ts'
import { THEME_SCHEMA_VERSION, themeDomainMigrate } from '../migration.ts'
import { createPresetBundle } from '../presetBundle.ts'
import { getRendererSettingsStore } from '../../../plugin-runtime/runtimeServices.ts'

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

  it('applies the saved theme delta back when switching to a custom preset', async () => {
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

    await useStore.getState().applyCustomPreset(id)

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

  it('returns an applied result after the complete provider transaction settles', async () => {
    const store = useStore.getState()
    store.setZoneField('chat', { chatFontSize: 21 })
    const id = store.saveCustomPreset('结果回归')

    const result = await useStore.getState().applyCustomPreset(id)
    expect(result).toMatchObject({ status: 'applied', id })
    if (result.status !== 'applied') throw new Error('custom preset unexpectedly failed')
    expect(result.providers).toEqual(expect.arrayContaining(['builtin.theme', 'builtin.presentation', 'builtin.renderer-settings']))
    expect(result.revision).toBeGreaterThan(0)
  })

  it('rejects a custom bundle without a valid Theme contribution instead of resetting to defaults', async () => {
    useStore.setState({ customPresets: [{
      id: 'custom-invalid-bundle', name: '损坏预设', theme: { chatFontSize: 29 }, createdAt: 1, updatedAt: 1,
      bundle: {
        manifestVersion: 2, id: 'custom-invalid-bundle', name: '损坏预设', source: 'user',
        contributions: {
          'builtin.renderer-settings': { ownerPluginId: 'builtin.pylon-renderers', providerVersion: 1, policy: 'partial', payload: {} },
        },
      },
    }] as never })
    useStore.getState().setZoneField('chat', { chatFontSize: 29 })

    const result = await useStore.getState().applyCustomPreset('custom-invalid-bundle')
    expect(result).toMatchObject({ status: 'failed', id: 'custom-invalid-bundle', failedProvider: 'builtin.theme', rolledBack: true })
    expect(useStore.getState().chatFontSize).toBe(29)
  })

  it('rolls back Theme and Presentation when a Renderer provider commit fails', async () => {
    const rendererStore = getRendererSettingsStore()
    const beforeRenderer = rendererStore.getSnapshot()
    useStore.getState().setZoneField('chat', { chatFontSize: 17 })
    useStore.setState({ customPresets: [{
      id: 'custom-renderer-failure', name: '渲染器失败', theme: { chatFontSize: 29 }, createdAt: 1, updatedAt: 1,
      bundle: createPresetBundle({
        id: 'custom-renderer-failure', name: '渲染器失败', now: 1, theme: { chatFontSize: 29 },
        presentation: { activeProfileId: 'profile-after', rendererSuiteIdByMode: { 'terminal-like': 'suite-after' } },
        renderer: { values: {}, unavailable: {} },
      }),
    }] as never })
    const originalReplace = rendererStore.replaceOverrides.bind(rendererStore)
    let replaceCalls = 0
    const replace = vi.spyOn(rendererStore, 'replaceOverrides').mockImplementation((values, unavailable) => {
      replaceCalls += 1
      if (replaceCalls === 1) throw new Error('renderer commit failed')
      originalReplace(values, unavailable)
    })
    try {
      const result = await useStore.getState().applyCustomPreset('custom-renderer-failure')
      expect(result).toMatchObject({ status: 'failed', failedProvider: 'builtin.renderer-settings', rolledBack: true })
      expect(useStore.getState().chatFontSize).toBe(17)
      expect(rendererStore.getSnapshot()).toMatchObject({ values: beforeRenderer.values, unavailable: beforeRenderer.unavailable })
      expect(replaceCalls).toBeGreaterThanOrEqual(2)
    } finally {
      replace.mockRestore()
    }
  })

  it('applies after a persistence roundtrip (localStorage rehydrate + migrate)', async () => {
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

    await useStore.getState().applyCustomPreset(id)
    expect(useStore.getState().chatFontSize).toBe(20)
    expect(useStore.getState().toolIndicatorRun).toBe('hourglass')
    expect(useStore.getState().appliedPreset.chat).toBe(id)
  })

  it('normalizes a legacy bare id at the click boundary', async () => {
    useStore.setState({ customPresets: [{
      id: 'custom-legacy-id', name: '旧 id', theme: { chatFontSize: 21 }, createdAt: 1, updatedAt: 1,
    }] })
    const result = await useStore.getState().applyCustomPreset('legacy-id')
    expect(result).toMatchObject({ status: 'applied', id: 'custom-legacy-id' })
    expect(useStore.getState().chatFontSize).toBe(21)
  })

  it('serializes rapid custom preset clicks so the later revision wins', async () => {
    useStore.setState({ customPresets: [
      { id: 'custom-first', name: '先', theme: { chatFontSize: 16 }, createdAt: 1, updatedAt: 1 },
      { id: 'custom-second', name: '后', theme: { chatFontSize: 22 }, createdAt: 2, updatedAt: 2 },
    ] })
    const first = useStore.getState().applyCustomPreset('custom-first')
    const second = useStore.getState().applyCustomPreset('custom-second')
    const [firstResult, secondResult] = await Promise.all([first, second])
    expect(firstResult.status).toBe('applied')
    expect(secondResult.status).toBe('applied')
    expect(secondResult.revision).toBeGreaterThan(firstResult.revision)
    expect(useStore.getState().chatFontSize).toBe(22)
    expect(useStore.getState().appliedPreset.global).toBe('custom-second')
  })

  it('reports a missing custom preset id instead of failing silently', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const before = snapshotState()
      await useStore.getState().applyCustomPreset('custom-does-not-exist')
      expect(spy).toHaveBeenCalled()
      expect(snapshotState()).toEqual(before)
    } finally {
      spy.mockRestore()
    }
  })
})
