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
  it('fresh appearance 使用 A6-2 默认值', () => {
    expect(DEFAULTS).toMatchObject({
      ccBg: '#808080',
      ccMarginX: 15,
      ccMarginBottom: 15,
      ccRadius: 25,
      inputHeight: 40,
      inputSurfaceBg: '#FFFFFF',
      inputSurfaceOpacity: 1,
      inputRadius: 20,
    })
  })

  it('只输出改变组件树/行为的结构字段，并冻结深层快照', () => {
    const source = theme({
      messageLayout: 'claude',
      inputOffsetTop: DEFAULTS.inputOffsetTop,
      inputHeight: DEFAULTS.inputHeight,
      inputMarginX: DEFAULTS.inputMarginX,
      inputSurfaceBg: DEFAULTS.inputSurfaceBg,
      inputSurfaceOpacity: DEFAULTS.inputSurfaceOpacity,
      inputBorder: DEFAULTS.inputBorder,
      inputBorderWidth: DEFAULTS.inputBorderWidth,
      inputBorderOpacity: DEFAULTS.inputBorderOpacity,
      inputRadius: DEFAULTS.inputRadius,
      inputFontSize: DEFAULTS.inputFontSize,
      inputTextColor: DEFAULTS.inputTextColor,
      inputPlaceholder: DEFAULTS.inputPlaceholder,
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
      ccBg: DEFAULTS.ccBg,
      ccSurfaceOpacity: DEFAULTS.ccSurfaceOpacity,
      ccBgImage: DEFAULTS.ccBgImage,
      ccMarginX: DEFAULTS.ccMarginX,
      ccMarginBottom: DEFAULTS.ccMarginBottom,
      ccRadius: DEFAULTS.ccRadius,
      ccHidden: ['send'],
      ccScale: { model: 125 },
      spinner: { framePreset: 'cc', verbSet: 'engineering' },
    })
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot.ccLayout)).toBe(true)
    expect(Object.isFrozen(snapshot.ccLayout.placements.input)).toBe(true)
    expect(Object.isFrozen(snapshot.ccHidden)).toBe(true)
    expect(Object.isFrozen(snapshot.ccScale)).toBe(true)
    expect(Object.isFrozen(snapshot.ccProperties)).toBe(true)
    expect(Object.isFrozen(snapshot.spinner)).toBe(true)
  })

  it('开关字段按 shown/hidden 归一投影为布尔（A6-1-FIX 1.1/1.3）', () => {
    const snapshot = selectWorkbenchAppearance(theme({
      inputFocusRingEnabled: 'hidden',
      inputShadowEnabled: 'shown',
    }), 1)

    expect(snapshot.inputFocusRingEnabled).toBe(false)
    expect(snapshot.inputShadowEnabled).toBe(true)
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

  it('中控背景色与背景图投影到快照并触发 Solid 外观更新', () => {
    const store = createStaticWorkbenchAppearanceStore(theme())
    const listener = vi.fn()
    store.subscribe(listener)

    store.setTheme(theme({
      ccBg: '#123456',
      ccBgImage: 'data:image/png;base64,fixture',
      ccSurfaceOpacity: 72,
      ccMarginX: 32,
      ccMarginBottom: 14,
      ccRadius: 12,
    }))

    expect(store.getSnapshot()).toMatchObject({
      ccBg: '#123456',
      ccBgImage: 'data:image/png;base64,fixture',
      ccSurfaceOpacity: 72,
      ccMarginX: 32,
      ccMarginBottom: 14,
      ccRadius: 12,
      revision: 1,
    })
    expect(listener).toHaveBeenCalledTimes(1)
    store.destroy()
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

  it('编辑命令更新高度、placement 与 schema 属性，并维持约束', () => {
    const store = createStaticWorkbenchAppearanceStore(theme())

    store.dispatch({ type: 'set-cc-height', height: 160 })
    store.dispatch({ type: 'update-cc-placement', id: 'model', placement: { offsetX: 99, offsetY: -99 } })
    store.dispatch({ type: 'set-cc-property', key: 'modelVariant', value: 'minimal' })

    expect(store.getSnapshot()).toMatchObject({ ccHeight: 160, modelVariant: 'minimal' })
    expect(store.getSnapshot().ccProperties.modelVariant).toBe('minimal')
    expect(store.getSnapshot().ccLayout.placements.model).toMatchObject({ offsetX: 48, offsetY: -16 })
    store.destroy()
  })

  it('非法数字编辑命令保留最后有效的中控布局与缩放', () => {
    const store = createStaticWorkbenchAppearanceStore(theme())
    store.dispatch({ type: 'update-cc-placement', id: 'model', placement: { order: 7, offsetX: 12 } })
    store.dispatch({ type: 'set-cc-scale', id: 'model', scale: 125 })

    store.dispatch({ type: 'update-cc-placement', id: 'model', placement: { order: Number.NaN, offsetX: Number.NaN } })
    store.dispatch({ type: 'set-cc-scale', id: 'model', scale: Number.NaN })

    expect(store.getSnapshot().ccLayout.placements.model).toMatchObject({ order: 7, offsetX: 12 })
    expect(store.getSnapshot().ccScale.model).toBe(125)
    store.destroy()
  })

  it('恢复隐藏控件后同步抬高中控高度', () => {
    const store = createStaticWorkbenchAppearanceStore(theme({
      inputMode: 'cli', inputVariant: 'cli', footerLayout: 'peri', cliHintMode: 'full',
      ccHeight: 84,
      ccHidden: ['session', 'workspace', 'activity', 'pct', 'tokens', 'send', 'attach', 'tasks'],
    }))

    store.dispatch({ type: 'set-cc-hidden', id: 'pct', hidden: false })
    store.dispatch({ type: 'set-cc-hidden', id: 'tokens', hidden: false })

    expect(store.getSnapshot()).toMatchObject({ ccHeight: 109 })
    store.destroy()
  })

  it('属性命令切换 CLI 后同步抬高中控高度', () => {
    const store = createStaticWorkbenchAppearanceStore(theme({
      inputMode: 'default', inputVariant: 'composer', footerLayout: 'peri', cliHintMode: 'full',
      ccHeight: 64,
    }))

    store.dispatch({ type: 'set-cc-property', key: 'inputMode', value: 'cli' })

    expect(store.getSnapshot()).toMatchObject({ inputMode: 'cli', ccHeight: 109 })
    store.destroy()
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
