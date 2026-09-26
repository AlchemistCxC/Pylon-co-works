// 迁移自 scripts/test-cc-height-state.mts（P91 A1）
import { describe, expect, it } from 'vitest'
import { clampCcHeight, resolveCcMinHeight, resolveVisibleStatusWidgetCount } from '../ccHeightState.ts'

describe('ccHeightState 状态栏可见计数', () => {
  it('resolveVisibleStatusWidgetCount 走通用 isWidgetVisible 计数', () => {
    // ★ #266 ⑰ 后：STATUS_WIDGET_IDS = [model, reasoning, mode, tokens, cc-command-hint]（5 个），
    // 可见性**只由隐藏名单决定**（会话 / 输入模式 / 条件都不再过问）⇒ 空名单即 5。
    expect(resolveVisibleStatusWidgetCount({ hiddenIds: [] })).toBe(5)
    expect(resolveVisibleStatusWidgetCount({ hiddenIds: ['model', 'mode'] })).toBe(3)
    expect(resolveVisibleStatusWidgetCount({ hiddenIds: ['tokens'] })).toBe(4)
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
