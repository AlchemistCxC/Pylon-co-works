// 迁移自 scripts/test-cc-height-state.mts（P91 A1）
import { describe, expect, it } from 'vitest'
import { ccMinHeightInputOf, clampCcHeight, resolveCcHeightGroups, resolveCcMinHeight, resolveCcMinWidth, resolveCcWidthGroups, resolveVisibleStatusWidgetCount } from '../ccHeightState.ts'
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

/**
 * ★★ #266 刀3：最小高 = `max( BASE_MIN_HEIGHT(64),
 *                            max( 算式(常态切面在场集合), 算式(空态切面在场集合) ) )`，
 * 其中 `算式(某态) = max over 该态各组 ( 该组高 + 该组到所贴竖边的距离 )`。
 *
 * 组 = **竖向落脚处**（`y.anchor:y.side`）：上边组 = 输入栏；下边组 = 状态行那一行
 * （#266 刀2.5 起行数恒 1 ⇒ 组高 = 该行在场件的最大高，不需要任何折行档）。
 *
 * ★ 两态取 max（用户 2026-09-28 定的退改）：空态切面是自由的、**可以比常态在场更多** ⇒ 只按常态算会低估。
 *
 * 数字口径（字段默认值）：输入栏高 40 + `inputOffsetTop` 10；下边组三个触发器各 28 +
 * `ccMarginBottom` 15；用量胶囊 / 命令行提示**无高度字段**（内容撑）⇒ 算式按 0。
 * ⇒ 全在场 + 默认高度 = `max(64, 10+40=50, 15+28=43)` = **64**（下界兜底 —— 与改造前的常量同值，
 *   这正是"默认口径行为不变"的那条判据）。
 */
describe('ccHeightState 最小高度（#266 刀3 · 按边算取最大 · 两态取 max）', () => {
  /** 默认口径的数字字段（全在场 + 各件默认高）。 */
  const DEFAULT_SCALARS = {
    inputOffsetTop: 10, inputHeight: 40, ccMarginBottom: 15,
    modelHeight: 28, reasoningHeight: 28, permissionHeight: 28,
  }
  const scalarsOf = (overrides: Record<string, number> = {}) => ({ ...DEFAULT_SCALARS, ...overrides })
  /** 默认两态都"什么都没藏"（= 最保守的一份现场）；要验两态差异时显式给两份切面。 */
  const minOf = (overrides: Record<string, number> = {}, slices: readonly (readonly string[])[] = [[], []]) =>
    resolveCcMinHeight({ hiddenSlices: slices, scalars: scalarsOf(overrides) })
  const groupsOf = (overrides: Record<string, number> = {}, hiddenIds: readonly string[] = []) =>
    resolveCcHeightGroups(hiddenIds, scalarsOf(overrides))
  const groupOf = (id: string, overrides: Record<string, number> = {}, hiddenIds: readonly string[] = []) =>
    groupsOf(overrides, hiddenIds).find(group => group.id === id)

  it('两组（上边 = 输入栏 / 下边 = 状态行）各算「组高 + 到边距离」，取 **max**（不是 sum）', () => {
    expect(groupsOf().map(group => group.id)).toEqual(['landing:cc-surface:top', 'landing:cc-surface:bottom'])
    // 上边组：高 = 输入栏高 40、到上边距离 = inputOffsetTop 10
    expect(groupOf('landing:cc-surface:top')).toEqual({ id: 'landing:cc-surface:top', height: 40, edgeGap: 10 })
    // 下边组：高 = 该行在场件的**最大**高（三个触发器都 28）、到下边距离 = ccMarginBottom 15
    expect(groupOf('landing:cc-surface:bottom')).toEqual({ id: 'landing:cc-surface:bottom', height: 28, edgeGap: 15 })
    // 默认口径两组都不足 64 ⇒ **下界兜底**（= 改造前常量，行为零变化）
    expect(minOf()).toBe(64)
    // 把输入栏那一组抬起来：10 + 120 = 130
    expect(minOf({ inputHeight: 120 })).toBe(130)
    // 把下边组抬起来：15 + 60 = 75（抬高一件即抬高整行 —— 行高取最大）
    expect(minOf({ modelHeight: 60 })).toBe(75)
    expect(minOf({ reasoningHeight: 60 })).toBe(75)
    // 两组同时大 ⇒ 取 **max 而不是 sum**（130 与 75 ⇒ 130；若相加会是 205）
    expect(minOf({ inputHeight: 120, modelHeight: 60 })).toBe(130)
  })

  it('★ 两态取 max（退改）：空态在场更多时，空态那一份算式才是绑定项', () => {
    // 常态藏掉那件高的（60）⇒ 常态算式 = 15 + 28 = 43；空态什么都没藏 ⇒ 空态算式 = 15 + 60 = 75
    // ⇒ 取 max = **75**（若只按常态算会得 64 ⇒ 低估空态、显示时可能超界）
    expect(minOf({ modelHeight: 60 }, [['model'], []])).toBe(75)
    // 反过来（常态在场更多、空态藏了那件高的）⇒ 取常态那一份，仍是 75
    expect(minOf({ modelHeight: 60 }, [[], ['model']])).toBe(75)
    // 两态都藏掉 ⇒ 两态算式都是 43 ⇒ 落回下界 64
    expect(minOf({ modelHeight: 60 }, [['model'], ['model']])).toBe(64)
    // 两态都空 ⇒ 75（与单态口径一致）
    expect(minOf({ modelHeight: 60 }, [[], []])).toBe(75)
    // 每态内部仍是"两组取 max"：常态输入栏组 130 与空态下边组 75 ⇒ 总 130
    expect(minOf({ inputHeight: 120, modelHeight: 60 }, [['model'], ['model']])).toBe(130)
  })

  it('★ 空态 = **主管 ∪ 再藏**（退改 D1）：`ccHiddenEmpty` 缺省 ⇒ 空态与主管同值', () => {
    // `ccMinHeightInputOf` 是唯一拼装点；★ #266 刀4 结构 C：第二份切片**不是**"再藏表本身"，
    // 而是空态真正的生效名单 = `ccHidden ∪ ccHiddenEmpty`（再藏只能加、不能抵消主管表）。
    expect(ccMinHeightInputOf({ ccHidden: ['model'] }).hiddenSlices).toEqual([['model'], ['model']])
    // ★ 退改 D1（改口径，不是放宽）：显式空再藏表 ⇒ 空态 = 主管（旧口径会读成 `[]`，
    //   等于"空态把主管表藏的件放出来" —— C 明确取消这种组合）
    expect(ccMinHeightInputOf({ ccHidden: ['model'], ccHiddenEmpty: [] }).hiddenSlices).toEqual([['model'], ['model']])
    // 并集 + 去重（相交部分不重复）
    expect(ccMinHeightInputOf({ ccHidden: ['model', 'tokens'], ccHiddenEmpty: ['tokens', 'mode'] }).hiddenSlices)
      .toEqual([['model', 'tokens'], ['model', 'tokens', 'mode']])
    expect(ccMinHeightInputOf({}).hiddenSlices).toEqual([[], []])
    // 两样都缺省（老数据 / 稀疏夹具）⇒ 两态同值，等价于单态
    expect(resolveCcMinHeight({ hiddenSlices: [[], []], scalars: scalarsOf({ modelHeight: 60 }) })).toBe(75)
    expect(resolveCcMinHeight(ccMinHeightInputOf({ ccHidden: [], ...scalarsOf({ modelHeight: 60 }) }))).toBe(75)
    // ★ 稀疏输入（连贴边距离字段都没给）⇒ 边距按 0 ⇒ 不再有 15 那一项（算式是"缺项按 0"）
    expect(resolveCcMinHeight(ccMinHeightInputOf({ ccHidden: [], modelHeight: 60 }))).toBe(64)
  })

  it('★ 退改 D1 探针：主管表藏掉「输入栏」⇒ 下界 64（旧口径会把输入栏放回来 ⇒ 130）', () => {
    // 输入栏高 120、上间距 10 ⇒ 输入栏那一组需求 = 130。主管表把它藏了 ⇒ 那一组不存在，
    // 下边组只剩 28 的行兜底（15 + 28 = 43）⇒ 落回下界 **64**。
    // ★ 旧口径（第二份切片 = `ccHiddenEmpty` 原值 ⇒ 输入栏在空态"被放回来"）会算成 **130**，
    //   偏高 66px —— 用户可见后果就是"藏了输入栏，容器降不下来"。
    const theme = { ccHidden: ['input'], ccHiddenEmpty: ['model', 'reasoning', 'mode', 'tokens', 'cc-send-button', 'cc-command-hint'], inputHeight: 120, inputOffsetTop: 10, modelHeight: 28, ccMarginBottom: 15 }
    expect(resolveCcMinHeight(ccMinHeightInputOf(theme))).toBe(64)
    // 反证：把输入栏从主管表挪回在场（两态都看得见它）⇒ 130（证明这条读数确实由"输入栏在不在场"决定）
    expect(resolveCcMinHeight(ccMinHeightInputOf({ ...theme, ccHidden: [] }))).toBe(130)
  })

  it('行高 ≥ 行兜底 28：整行都是"内容撑"件（或全藏起来）时不至于算成 0', () => {
    // 只留用量胶囊 + 命令行提示（两者都没有 heightField）⇒ 组高落回行兜底
    expect(groupOf('landing:cc-surface:bottom', {}, ['model', 'reasoning', 'mode'])!.height).toBe(28)
    // 把三个触发器的高度都设小（16）也不会低于行兜底
    expect(groupOf('landing:cc-surface:bottom', { modelHeight: 16, reasoningHeight: 16, permissionHeight: 16 })!.height).toBe(28)
    // 整行藏光 ⇒ 这个组压根不存在（不在场的不参与），上边组仍在下界里
    const allHidden = ['model', 'reasoning', 'mode', 'tokens', 'cc-command-hint']
    expect(groupsOf({}, allHidden).map(group => group.id)).toEqual(['landing:cc-surface:top'])
    expect(minOf({}, [allHidden, allHidden])).toBe(64)
  })

  it('★ 在场集合变化 ⇒ 最小高随之（全在 75 / 藏 1 件 64 / 只剩内容撑件 64）', () => {
    // 下边组抬高到 60 ⇒ 全在时下边组需求 = 15 + 60 = 75（绑定的那一组）
    expect(minOf({ modelHeight: 60 })).toBe(75)
    // 两态都藏掉那件高的（行里还剩 28 的两件）⇒ 需求回落到 15 + 28 = 43 ⇒ 下界 64
    expect(minOf({ modelHeight: 60 }, [['model'], ['model']])).toBe(64)
    // 两态都藏到只剩内容撑件 ⇒ 行兜底 28 ⇒ 15 + 28 = 43 ⇒ 仍是下界 64
    expect(minOf({ modelHeight: 60 }, [['model', 'reasoning', 'mode'], ['model', 'reasoning', 'mode']])).toBe(64)
    // 反过来把输入栏那一组抬高：藏掉整个下边组也压不下去（两组取 max）
    const allBottom = ['model', 'reasoning', 'mode', 'tokens', 'cc-command-hint']
    expect(minOf({ inputHeight: 120 }, [allBottom, allBottom])).toBe(130)
  })

  it('悬浮件（发送按钮）不占流 ⇒ 不进任何组（它骑在输入栏上，高度跟输入栏走）', () => {
    expect(groupsOf().map(group => group.id).join()).not.toContain('cc-send-button')
  })

  it('clampCcHeight：下界 = 算式结果，上界 400，非有限值回落下界', () => {
    const plain = { hiddenSlices: [[], []], scalars: scalarsOf() }
    const raised = { hiddenSlices: [[], []], scalars: scalarsOf({ inputHeight: 120 }) }
    expect(clampCcHeight(0, plain)).toBe(64)
    expect(clampCcHeight(20, plain)).toBe(64)
    expect(clampCcHeight(999, plain)).toBe(400)
    expect(clampCcHeight(150, plain)).toBe(150)
    // 下界抬高后：低于下界必被抬到 130；区间内原样；上界仍是 400
    expect(clampCcHeight(0, raised)).toBe(130)
    expect(clampCcHeight(200, raised)).toBe(200)
    expect(clampCcHeight(999, raised)).toBe(400)
    // 非有限值回落**下界**（既有语义：`Number.isFinite` 为假 ⇒ 取 min；下界现在是算式结果）
    expect(clampCcHeight(Number.NaN, plain)).toBe(64)
    expect(clampCcHeight(Number.NaN, raised)).toBe(130)
  })

  it('不变量：下界 ≤ 值 ≤ 400（随机口径 × 两态组合逐条夹）', () => {
    const cases: Array<Record<string, number>> = [
      {}, { inputHeight: 120 }, { modelHeight: 80 }, { ccMarginBottom: 100, modelHeight: 80 },
      { inputOffsetTop: 120, inputHeight: 200 }, { modelHeight: 16 },
    ]
    const slicePairs: Array<readonly (readonly string[])[]> = [
      [[], []], [['model'], []], [[], ['model']], [['model', 'reasoning'], ['mode']],
    ]
    for (const scalars of cases) {
      for (const hiddenSlices of slicePairs) {
        const input = { hiddenSlices, scalars: scalarsOf(scalars) }
        const floor = resolveCcMinHeight(input)
        for (const value of [0, 1, 63, 64, 100, 400, 999, Number.NaN, -5]) {
          const clamped = clampCcHeight(value, input)
          expect(clamped, `${JSON.stringify(scalars)}/${JSON.stringify(hiddenSlices)}/${value}`).toBeGreaterThanOrEqual(floor)
          expect(clamped).toBeLessThanOrEqual(400)
        }
      }
    }
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
