import { describe, expect, it, vi } from 'vitest'
import { cloneCcLayout } from '../../../ccLayoutState.ts'
import { DEFAULTS } from '../../theme/themeDefaults.ts'
import { GLOBAL_PRESETS } from '../../../presets.ts'
import type { ThemeSettings } from '../../../store.ts'
import { selectWorkbenchAppearance } from '../appearance.ts'
import {
  createStaticWorkbenchAppearanceStore,
  createVanillaWorkbenchAppearanceStore,
} from '../workbenchAppearanceStore.ts'

function theme(overrides: Partial<ThemeSettings> = {}): ThemeSettings {
  return {
    ...structuredClone(DEFAULTS),
    ...structuredClone(overrides),
    ccLayout: cloneCcLayout(overrides.ccLayout ?? DEFAULTS.ccLayout),
  }
}

describe('selectWorkbenchAppearance', () => {
  it('只输出改变组件树/行为的结构字段，并冻结深层快照', () => {
    const source = theme({
      messageLayout: 'claude',
      assistantDot: true,
      ccHidden: ['send'],
      ccScale: { model: 125 },
      spinnerFramePreset: 'cc',
      spinnerVerbSet: 'engineering',
    })
    const snapshot = selectWorkbenchAppearance(source, 3)

    expect(snapshot).toMatchObject({
      revision: 3,
      messageLayout: 'claude',
      assistantDot: true,
      ccHidden: ['send'],
      ccScale: { model: 125 },
      spinner: { framePreset: 'cc', verbSet: 'engineering' },
    })
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot.ccLayout)).toBe(true)
    expect(Object.isFrozen(snapshot.ccLayout.placements.input)).toBe(true)
    expect(Object.isFrozen(snapshot.ccHidden)).toBe(true)
    expect(Object.isFrozen(snapshot.ccScale)).toBe(true)
    expect(Object.isFrozen(snapshot.spinner)).toBe(true)
  })

  it('custom spinner 使用自定义 frames/verbs，并收窄 interval', () => {
    const snapshot = selectWorkbenchAppearance(theme({
      spinnerFramePreset: 'custom',
      spinnerCustomFrames: '甲甲乙',
      spinnerVerbSet: 'custom',
      spinnerCustomVerbs: '读取, 验证\n构建',
      spinnerIntervalMs: 2,
    }), 0)

    expect(snapshot.spinner.frames).toEqual(['甲', '乙'])
    expect(snapshot.spinner.verbs).toEqual(['读取', '验证', '构建'])
    expect(snapshot.spinner.intervalMs).toBe(40)
  })

  it('动态枚举全部内置预设均可产生合法 snapshot', () => {
    for (const preset of GLOBAL_PRESETS) {
      const snapshot = selectWorkbenchAppearance(theme(preset.theme), 0)
      expect(snapshot.messageLayout, preset.name).toMatch(/classic|claude|bubble/)
      expect(snapshot.spinner.frames.length, preset.name).toBeGreaterThan(0)
      expect(snapshot.ccBgHeight, preset.name).toBeGreaterThanOrEqual(snapshot.ccHeight)
    }
  })

  it('内置预设的非聊天界面统一使用系统字体', () => {
    for (const preset of GLOBAL_PRESETS) {
      expect(preset.theme.globalFont ?? DEFAULTS.globalFont, preset.name).toBe('system')
    }
    expect(DEFAULTS.chatFont).toBe('mono')
    expect(DEFAULTS.msgFont).toBe('mono')
  })
})

describe('createStaticWorkbenchAppearanceStore', () => {
  it('非结构颜色变化不 bump revision，结构变化只通知一次', () => {
    const store = createStaticWorkbenchAppearanceStore(theme())
    const listener = vi.fn()
    store.subscribe(listener)
    const initial = store.getSnapshot()

    store.setTheme(theme({ chatBg: '#123456' }))
    expect(store.getSnapshot()).toBe(initial)
    expect(listener).not.toHaveBeenCalled()

    store.setTheme(theme({ messageLayout: 'bubble' }))
    expect(store.getSnapshot().revision).toBe(1)
    expect(store.getSnapshot().messageLayout).toBe('bubble')
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('appearance command 更新 fake theme，destroy 后停止通知', () => {
    const store = createStaticWorkbenchAppearanceStore(theme())
    const listener = vi.fn()
    store.subscribe(listener)

    store.dispatch({ type: 'set-cc-hidden', id: 'tasks', hidden: true })
    store.dispatch({ type: 'set-cc-scale', id: 'model', scale: 500 })
    store.dispatch({ type: 'set-cc-edit-mode', enabled: true })

    expect(store.getSnapshot()).toMatchObject({
      ccHidden: ['tasks'],
      ccScale: { model: 200 },
      ccEditMode: true,
      revision: 3,
    })

    store.destroy()
    store.dispatch({ type: 'set-cc-edit-mode', enabled: false })
    expect(listener).toHaveBeenCalledTimes(3)
    expect(store.getSnapshot().ccEditMode).toBe(true)
  })
})

describe('createVanillaWorkbenchAppearanceStore', () => {
  it('订阅外部 vanilla source，忽略非结构变化并正确 unsubscribe', () => {
    let state = theme()
    const listeners = new Set<(next: ThemeSettings, previous: ThemeSettings) => void>()
    const source = {
      getState: () => state,
      subscribe(listener: (next: ThemeSettings, previous: ThemeSettings) => void) {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    }
    const dispatch = vi.fn()
    const store = createVanillaWorkbenchAppearanceStore(source, dispatch)
    const listener = vi.fn()
    store.subscribe(listener)

    const previousColor = state
    state = theme({ chatBg: '#abcdef' })
    for (const notify of listeners) notify(state, previousColor)
    expect(listener).not.toHaveBeenCalled()

    const previousStructure = state
    state = theme({ messageLayout: 'claude' })
    for (const notify of listeners) notify(state, previousStructure)
    expect(listener).toHaveBeenCalledTimes(1)
    expect(store.getSnapshot().revision).toBe(1)

    store.dispatch({ type: 'reset-cc-layout' })
    expect(dispatch).toHaveBeenCalledWith({ type: 'reset-cc-layout' })

    store.destroy()
    expect(listeners.size).toBe(0)
  })
})
