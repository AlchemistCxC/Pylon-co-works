// 迁移自 scripts/test-cc-height-state.mts（P91 A1）
import { describe, expect, it } from 'vitest'
import { clampCcHeight, resolveCcMinHeight, resolveCcMinWidth, resolveCcWidthGroups, resolveVisibleStatusWidgetCount } from '../ccHeightState.ts'
import { resolveCcWidgetGroup, type CcDetachX } from '../widgetDefinitions.ts'

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

/**
 * ★★ #266 刀2.5：横向 —— 最小宽。与最小高**同构**：`max over 各组 ( 组宽 + 该组到所贴横边的距离 )`。
 *
 * 数字口径（三个触发器的宽度字段默认各 120；用量 / 命令行提示是内容撑 ⇒ 算式计 0）：
 * 下边组在场五件 = model(120, 行级 gap 0) + reasoning(120, gap 12) + mode(120, gap 12)
 * + tokens(0) + cc-command-hint(0) ⇒ 队列组宽 **384**。
 * 「组」与最小高同源（一个横向落脚处），但取法不同 —— 件并排 ⇒ 组宽取**和**（高度那边取最大）。
 */
describe('ccHeightState 最小宽度（#266 刀2.5 · 与最小高同构）', () => {
  const WIDTHS = { model: 120, reasoning: 120, mode: 120 }
  const bottomQueue = (groups: ReturnType<typeof resolveCcWidthGroups>) =>
    groups.find(group => group.id === 'queue:cc-surface:bottom')!

  it('resolveCcMinWidth = max( 组宽 + 到所贴横边的距离 )，**不是求和**', () => {
    expect(resolveCcMinWidth([])).toBe(0)
    expect(resolveCcMinWidth([{ id: 'a', width: 100, edgeGap: 12 }])).toBe(112)
    // 横向允许重叠（声明式脱离）⇒ 两组取最大，不相加
    expect(resolveCcMinWidth([
      { id: '队列', width: 384, edgeGap: 0 },
      { id: '脱离件', width: 32, edgeGap: 100 },
    ])).toBe(384)
  })

  it('组 = 落脚处：组宽 = 在场件宽之和 + 行级前置间距（全在 = 384）', () => {
    const groups = resolveCcWidthGroups([], WIDTHS)
    expect(groups.map(group => group.id)).toEqual(['queue:cc-surface:top', 'queue:cc-surface:bottom'])
    // 120 + (120 + 12) + (120 + 12) + 0 + 0 = 384
    expect(bottomQueue(groups).width).toBe(384)
    expect(bottomQueue(groups).edgeGap).toBe(0)
    expect(resolveCcMinWidth(groups)).toBe(384)
    // 输入栏那一组是 `stretch`（内容不撑宽）⇒ 不构成约束
    expect(groups.find(group => group.id === 'queue:cc-surface:top')!.width).toBe(0)
  })

  it('藏 1 件 / 只剩 1 件 ⇒ 队列组宽随之（252 / 120）', () => {
    expect(bottomQueue(resolveCcWidthGroups(['mode'], WIDTHS)).width).toBe(252)
    expect(resolveCcMinWidth(resolveCcWidthGroups(['mode'], WIDTHS))).toBe(252)
    const lastOne = resolveCcWidthGroups(['reasoning', 'mode', 'tokens', 'cc-command-hint'], WIDTHS)
    expect(bottomQueue(lastOne).width).toBe(120)
    expect(resolveCcMinWidth(lastOne)).toBe(120)
  })

  it('悬浮件（发送按钮）不进任何组：它的宽度由 --cc-send-size 自算', () => {
    expect(resolveCcWidthGroups([], WIDTHS).map(group => group.id).join()).not.toContain('cc-send-button')
  })

  /**
   * ★ 声明式脱离在算式里的体现：脱离件**自成一"组"**（宽 + 到所贴边的距离），**不**计入队列之和
   * —— 两者取 max（因为允许重叠）⇒ 是 **320**，而**不是** 252+320=572。
   *
   * 声明位在定义表上（静态真值），所以这里临时声明、`finally` 收回；测的正是验收项 3 的
   * 「声明 ⇒ 脱离 / 撤回 ⇒ 回队列」（渲染侧另有一条 DOM 级用例）。
   */
  it('声明了 detachX 的件自成一"组"、不与队列相加（max 而非 sum）', () => {
    const modeRow = resolveCcWidgetGroup('mode') as { detachX?: CcDetachX }
    modeRow.detachX = { anchor: 'cc-surface', side: 'right', gap: 200 }
    try {
      const groups = resolveCcWidthGroups([], WIDTHS)
      // 队列少一件 ⇒ 120 + (120 + 12) + 0 + 0 = 252
      expect(bottomQueue(groups).width).toBe(252)
      expect(groups.find(group => group.id === 'mode')).toEqual({ id: 'mode', width: 120, edgeGap: 200 })
      expect(resolveCcMinWidth(groups)).toBe(320)
      expect(resolveCcMinWidth(groups)).not.toBe(252 + 320)
    } finally {
      delete modeRow.detachX
    }
    // 撤回声明 ⇒ 回到队列（"未声明 = 照旧排队"）
    expect(resolveCcMinWidth(resolveCcWidthGroups([], WIDTHS))).toBe(384)
  })
})
