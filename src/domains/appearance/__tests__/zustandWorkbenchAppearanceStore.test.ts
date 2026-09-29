// @vitest-environment jsdom
/**
 * ★ #266 刀3 退改②：**生产通路**的高度落点。
 *
 * 生产 App 的显隐/高度写入走 **zustand**：`createZustandWorkbenchAppearanceStore()` →
 * `store.ts` 的 `setCcHidden` / `setCcHeight`（见 `agentWorkbenchSession.ts`），
 * 而 `workbenchAppearanceStore.createStaticWorkbenchAppearanceStore` 那一套是**预览 / 测试**用的另一条实现。
 * 两条实现各自持一份 clamp 落点 —— 刀3 两套都改了，但此前单测只覆盖静态那套
 * （`appearance.test.ts`），**生产这条没有直达用例**（一次反向验证"打错位置却不变红"就是这么暴露的）。
 * 本文件补上这条缝：只断言**生产通路**（zustand 动作 + 订阅回推），不碰静态实现。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { createZustandWorkbenchAppearanceStore } from '../zustandWorkbenchAppearanceStore.ts'
import { useStore } from '../../theme/themeStore.ts'
import { resetStores } from '../../../test/resetStores.ts'

/** 起一片"生产态"的重置：四个 store 回初始态 + 清持久化。 */
beforeEach(() => {
  localStorage.clear()
  resetStores()
})

describe('#266 刀3 · 生产通路（zustand）：高度下界按算式走', () => {
  it('★ 改显隐 ⇒ 最小高跟着变（藏 / 显那件高的前后各一读数）', () => {
    // 下边组里放一件高 60（其余两件 28）⇒ 它在场时下边组需求 = ccMarginBottom 15 + 60 = 75。
    // 空态切面按出厂口径也藏着它（出厂那 6 件含 model）⇒ 两态算式同值，读数干净。
    useStore.setState({ ccHeight: 20, modelHeight: 60, ccHidden: [], ccHiddenEmpty: ['model'] })
    const appearance = createZustandWorkbenchAppearanceStore()

    // 藏掉那件高的（两态都藏）⇒ 行高回落到 28 ⇒ 下界 = max(64, 10+40, 15+28) = **64**
    appearance.dispatch({ type: 'set-cc-hidden', id: 'model', hidden: true })
    expect(useStore.getState().ccHidden).toEqual(['model'])
    expect(useStore.getState().ccHeight, '生产通路：显隐一变高度要重过 clamp').toBe(64)
    expect(appearance.getSnapshot().ccHeight, '回推的快照与 store 同步').toBe(64)

    // 放出来 ⇒ 常态下边组需求 75 成为绑定项（空态仍藏着它、只算 43）⇒ 两态取 max = **75**
    appearance.dispatch({ type: 'set-cc-hidden', id: 'model', hidden: false })
    expect(useStore.getState().ccHidden).toEqual([])
    expect(useStore.getState().ccHeight).toBe(75)
    expect(appearance.getSnapshot().ccHeight).toBe(75)

    appearance.destroy()
  })

  it('★ set-cc-height 也走算式下界（不是常量 64）', () => {
    useStore.setState({ ccHeight: 20, modelHeight: 60, ccHidden: [], ccHiddenEmpty: [] })
    const appearance = createZustandWorkbenchAppearanceStore()

    appearance.dispatch({ type: 'set-cc-height', height: 20 })
    expect(useStore.getState().ccHeight).toBe(75)

    // 区间内原样 / 上界仍 400
    appearance.dispatch({ type: 'set-cc-height', height: 200 })
    expect(useStore.getState().ccHeight).toBe(200)
    appearance.dispatch({ type: 'set-cc-height', height: 999 })
    expect(useStore.getState().ccHeight).toBe(400)

    appearance.destroy()
  })

  it('★ 两态取 max：空态在场更多时，下界由空态那一份切面决定（生产通路同样）', () => {
    // 常态藏掉那件高的（在先）⇒ 常态算式 43；空态什么都没藏 ⇒ 空态算式 75 ⇒ 下界 75
    useStore.setState({ ccHeight: 20, modelHeight: 60, ccHidden: ['model'], ccHiddenEmpty: [] })
    const appearance = createZustandWorkbenchAppearanceStore()

    // 触发一次 clamp（改高度即可）：下界必须是两态 max = 75，而不是常态那一份的 64
    appearance.dispatch({ type: 'set-cc-height', height: 20 })
    expect(useStore.getState().ccHeight).toBe(75)

    // 把空态也藏掉同一件 ⇒ 两态同值 43 ⇒ 回落到下界 64
    useStore.setState({ ccHiddenEmpty: ['model'] })
    appearance.dispatch({ type: 'set-cc-height', height: 20 })
    expect(useStore.getState().ccHeight).toBe(64)

    appearance.destroy()
  })
})
