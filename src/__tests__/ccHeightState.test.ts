// 迁移自 scripts/test-cc-height-state.mts（P91 A1）
import { describe, expect, it } from 'vitest'
import { clampCcHeight, resolveCcMinHeight, resolveVisibleStatusWidgetCount } from '../ccHeightState.ts'

describe('ccHeightState 状态栏可见计数', () => {
  it('resolveVisibleStatusWidgetCount 走通用 isWidgetVisible 计数', () => {
    // 刀4 名单换代后 STATUS_WIDGET_IDS = [model, reasoning, mode, tokens]（4 个），
    // 可见性只由 hidden 决定（numeric 去重 / 外部按钮 / terminal-classic 三条规则随被删元件退场）。
    expect(resolveVisibleStatusWidgetCount({ hiddenIds: [], inputMode: 'cli', submitButtonMode: 'inline' })).toBe(4)
    expect(resolveVisibleStatusWidgetCount({ hiddenIds: ['model', 'mode'], inputMode: 'cli', submitButtonMode: 'inline' })).toBe(2)
    expect(resolveVisibleStatusWidgetCount({ hiddenIds: ['tokens'], inputMode: 'cli', submitButtonMode: 'inline' })).toBe(3)
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
