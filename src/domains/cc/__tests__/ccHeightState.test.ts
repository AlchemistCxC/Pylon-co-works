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
  /**
   * ★ #266 刀9/刀10/刀11：形态收敛成唯一一种（命令行输入 + 独立状态行 + 随内容增高）后，
   * `resolveCcMinHeight` 退化为常量 64 —— 原先那两个会涨上去的取值（peri + hint 84 / 109）
   * 随 `footerLayout` / `cliOverflowMode` 字段一并退场。
   *
   * 改造前的等价性：`free` 形态（唯一形态，也是用户实际在用的）走的就是
   * `inputMode !== 'cli' || footerLayout !== 'peri'` ⇒ `return BASE_MIN_HEIGHT` 这一支。
   */
  it('单一形态 ⇒ 常量 64（不再随形态/详细档/可见控件数浮动）', () => {
    expect(resolveCcMinHeight()).toBe(64)
    expect(clampCcHeight(0)).toBe(64)
  })

  it('clampCcHeight 以最小高度与 400 上限夹紧', () => {
    expect(clampCcHeight(20)).toBe(64)
    expect(clampCcHeight(999)).toBe(400)
    expect(clampCcHeight(150)).toBe(150)
    // 非有限值回落最小高（原行为：`Number.isFinite` 为假 ⇒ 取 min）
    expect(clampCcHeight(Number.NaN)).toBe(64)
  })
})
