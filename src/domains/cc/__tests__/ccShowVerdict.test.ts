import { describe, expect, it } from 'vitest'
import { resolveCcShowVerdict, type CcShowVerdictInput } from '../ccShowVerdict.ts'
import type { CcWidgetWidthIndex } from '../ccHeightState.ts'

/**
 * #266 刀4：**显示前校验**的判据（纯函数）。
 *
 * 口径（施工单 §四 C1 / §三）：
 * - 两态各算一遍取 max（纵向 `resolveCcMinHeight`、横向逐态取大）；
 * - `needed > available` ⇒ 拒；**相等 = 正好装下 ⇒ 放行**；
 * - 两侧尺寸量不到（0 / 非有限）⇒ 该方向 fail-open（放行）；
 * - 先纵向后横向（一次只报一个方向）。
 *
 * 数字怎么来的（这套 scalars 与既有 `--cc-min-width = 384` 的口径一致）：
 * - 纵向：`ccMarginBottom 15 + modelHeight 60 = 75`（model 在场时下边组需求）；
 *   model 不在场 ⇒ 下边组只剩 28 的行兜底 ⇒ `15 + 28 = 43`，下界 64。
 *   输入栏那一组 `inputOffsetTop 10 + inputHeight 40 = 50`。
 * - 横向：下边队列 = `120 + (12) + 120 + (12) + 120 = 384`（model / reasoning / mode 各 120，
 *   reasoning 与 mode 各带 12 的前置间距）；把它们藏掉 ⇒ 264。
 */
const SCALARS = { inputOffsetTop: 10, inputHeight: 40, ccMarginBottom: 15, modelHeight: 60 }
const WIDTHS: CcWidgetWidthIndex = { model: 120, reasoning: 120, mode: 120 }

/** 常态 / 空态两份名单（=`ccMinHeightInputOf` 交出的那种形状）。 */
const inputOf = (normal: readonly string[], empty: readonly string[]): CcShowVerdictInput => ({
  hiddenSlices: [normal, empty],
  scalars: SCALARS,
  widths: WIDTHS,
})

describe('#266 刀4 · resolveCcShowVerdict', () => {
  it('相等 ⇒ 放行（正好装下，不是"差一点"）', () => {
    expect(resolveCcShowVerdict(inputOf([], []), { width: 384, height: 75 })).toEqual({ ok: true })
  })

  it('差 1px ⇒ 拒，并把 needed / available / axis 如实带出（提示话术直接用这三个数）', () => {
    expect(resolveCcShowVerdict(inputOf([], []), { width: 1000, height: 74 }))
      .toEqual({ ok: false, axis: 'height', needed: 75, available: 74 })
  })

  it('★ 空态更严时以**空态**那一份为准（只算常态切面会在这里放行）', () => {
    // 常态藏着那件高的（需求 64）、空态啥都没藏（需求 75）⇒ 取 max = 75
    expect(resolveCcShowVerdict(inputOf(['model'], []), { width: 1000, height: 74 }))
      .toEqual({ ok: false, axis: 'height', needed: 75, available: 74 })
    // 反证：只按常态那一份算会得到 64 ≤ 74 ⇒ 放行（错）。这里用"两态都藏"当对照组：
    // 两态都藏 ⇒ 两态需求都是 64 ⇒ 74 够用 ⇒ 放行。两条合起来证明它确实逐态取了 max。
    expect(resolveCcShowVerdict(inputOf(['model'], ['model']), { width: 1000, height: 74 }))
      .toEqual({ ok: true })
  })

  it('横向被拒：纵向够、宽度差 1px ⇒ axis = width', () => {
    expect(resolveCcShowVerdict(inputOf([], []), { width: 383, height: 1000 }))
      .toEqual({ ok: false, axis: 'width', needed: 384, available: 383 })
    // 横向也算两态：常态藏掉那三件触发器（队列 264）、空态没藏（384）⇒ 取 max = 384
    expect(resolveCcShowVerdict(inputOf(['model', 'reasoning', 'mode'], []), { width: 383, height: 1000 }))
      .toEqual({ ok: false, axis: 'width', needed: 384, available: 383 })
  })

  it('两个方向都不够 ⇒ 先报**纵向**（判定顺序固定，一次只报一个方向）', () => {
    expect(resolveCcShowVerdict(inputOf([], []), { width: 100, height: 10 }))
      .toEqual({ ok: false, axis: 'height', needed: 75, available: 10 })
  })

  it('★ fail-open：量不到尺寸（0 / 非有限）⇒ 该方向放行（宁可偶尔不拦，也不禁止用户操作）', () => {
    // 两个方向都量不到（元素未挂载 / 测试环境无布局）
    expect(resolveCcShowVerdict(inputOf([], []), { width: 0, height: 0 })).toEqual({ ok: true })
    // 只有纵向量到 ⇒ 纵向照判，横向放行
    expect(resolveCcShowVerdict(inputOf([], []), { width: 0, height: 10 }))
      .toEqual({ ok: false, axis: 'height', needed: 75, available: 10 })
    // 只有横向量到 ⇒ 横向照判，纵向放行
    expect(resolveCcShowVerdict(inputOf([], []), { width: 10, height: 0 }))
      .toEqual({ ok: false, axis: 'width', needed: 384, available: 10 })
    // 非有限值同样按"量不到"处理（不抛、不误判成 0 需求）
    expect(resolveCcShowVerdict(inputOf([], []), { width: Number.NaN, height: Number.NaN })).toEqual({ ok: true })
  })

  it('名单为空数组（调用方没给两态）⇒ 按"什么都不藏"算，不抛错', () => {
    expect(resolveCcShowVerdict({ hiddenSlices: [], scalars: SCALARS, widths: WIDTHS }, { width: 1000, height: 74 }))
      .toEqual({ ok: false, axis: 'height', needed: 75, available: 74 })
  })

  it('纯函数：不改传入的名单与尺寸对象', () => {
    const input = inputOf(['model'], ['tokens'])
    const frozen = structuredClone(input)
    const available = { width: 100, height: 10 }
    resolveCcShowVerdict(input, available)
    expect(input).toEqual(frozen)
    expect(available).toEqual({ width: 100, height: 10 })
  })
})
