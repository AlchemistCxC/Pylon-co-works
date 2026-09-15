// 迁移自 scripts/test-cc-height-state.mts（P91 A1）
import { describe, expect, it } from 'vitest'
import { clampCcHeight, resolveCcMinHeight, resolveVisibleStatusWidgetCount } from '../ccHeightState.ts'

describe('ccHeightState 状态栏可见计数', () => {
  it('resolveVisibleStatusWidgetCount 走通用 isWidgetVisible 计数', () => {
    // P1-07：tasks widget 登记进 STATUS_WIDGET_IDS（由 CC_WIDGET_IDS 派生），计数 +1；
    // 走通用 isWidgetVisible（hidden/numeric/外部按钮机制自动覆盖）
    expect(resolveVisibleStatusWidgetCount({ hiddenIds: [], inputMode: 'cli', ccStyle: 'wave', submitButtonMode: 'inline' })).toBe(9)
    expect(resolveVisibleStatusWidgetCount({ hiddenIds: ['model', 'mode'], inputMode: 'cli', ccStyle: 'wave', submitButtonMode: 'inline' })).toBe(7)
    expect(resolveVisibleStatusWidgetCount({ hiddenIds: [], inputMode: 'cli', ccStyle: 'numeric', submitButtonMode: 'inline' })).toBe(8)
    expect(resolveVisibleStatusWidgetCount({ hiddenIds: ['tokens'], inputMode: 'cli', ccStyle: 'numeric', submitButtonMode: 'inline' })).toBe(8)
    expect(resolveVisibleStatusWidgetCount({ hiddenIds: ['tasks'], inputMode: 'cli', ccStyle: 'wave', submitButtonMode: 'inline' })).toBe(8)
    expect(resolveVisibleStatusWidgetCount({
      hiddenIds: [], inputMode: 'cli', ccStyle: 'wave', submitButtonMode: 'inline',
      presentationProfileId: 'builtin.presentation.terminal-classic',
    })).toBe(6)
  })
})

describe('ccHeightState 最小高度', () => {
  it('resolveCcMinHeight 按输入模式/footer/hint/换行状态行计算布局约束', () => {
    expect(resolveCcMinHeight({
      inputMode: 'default', footerLayout: 'free', hintMode: 'full', visibleStatusWidgets: 7, cliOverflowMode: 'fixed-scroll',
    })).toBe(64)
    expect(resolveCcMinHeight({
      inputMode: 'cli', footerLayout: 'free', hintMode: 'full', visibleStatusWidgets: 5, cliOverflowMode: 'fixed-scroll',
    })).toBe(64)
    expect(resolveCcMinHeight({
      inputMode: 'cli', footerLayout: 'peri', hintMode: 'hidden', visibleStatusWidgets: 4, cliOverflowMode: 'fixed-scroll',
    })).toBe(64)
    expect(resolveCcMinHeight({
      inputMode: 'cli', footerLayout: 'peri', hintMode: 'full', visibleStatusWidgets: 4, cliOverflowMode: 'fixed-scroll',
    })).toBe(84)
    expect(resolveCcMinHeight({
      inputMode: 'cli', footerLayout: 'peri', hintMode: 'full', visibleStatusWidgets: 5, cliOverflowMode: 'fixed-scroll',
    })).toBe(109)
    expect(resolveCcMinHeight({
      inputMode: 'cli', footerLayout: 'peri', hintMode: 'full', visibleStatusWidgets: 7, cliOverflowMode: 'grow',
    })).toBe(64)
  })

  it('clampCcHeight 以最小高度与 400 上限夹紧', () => {
    expect(clampCcHeight(20, {
      inputMode: 'cli', footerLayout: 'peri', hintMode: 'full', visibleStatusWidgets: 5, cliOverflowMode: 'fixed-scroll',
    })).toBe(109)
    expect(clampCcHeight(999, {
      inputMode: 'cli', footerLayout: 'peri', hintMode: 'full', visibleStatusWidgets: 5, cliOverflowMode: 'fixed-scroll',
    })).toBe(400)
  })
})
