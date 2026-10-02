/** @jsxImportSource solid-js */
// @vitest-environment jsdom
/**
 * #309：模态覆盖层让位事实的聚合语义——任一打开即 open，全部释放才关闭；
 * veil 槽位在卸载时自动释放（覆盖层组件可能条件渲染，卸载路径必须自愈）。
 * #515：React Probe（useModalOverlayVeil）→ solid Probe（createEffect + onCleanup，
 * 与 App.solid createVeil / PermissionDialog.solid 的生产内联形态同构）。断言集补齐（#515 二轮审查：初版迁移漏掉「同一 key 重复声明不产生重复槽位」用例，本轮恢复——原版 7 断言/3 it 全量在场）。
 */
import { cleanup, render } from '@solidjs/testing-library'
import { createEffect, onCleanup } from 'solid-js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useModalOverlayStore } from '../modalOverlayStore'

function Probe(props: { id: string; open: boolean }) {
  // React 版 `useEffect(fn, [open])` mount 即跑——这里不用 defer，保持同语义。
  createEffect(() => {
    const isOpen = props.open
    useModalOverlayStore.getState().setOverlayOpen(props.id, isOpen)
    onCleanup(() => useModalOverlayStore.getState().setOverlayOpen(props.id, false))
  })
  return null
}

afterEach(() => cleanup())

describe('modalOverlayStore（#309）', () => {
  beforeEach(() => {
    useModalOverlayStore.setState({ openKeys: new Set<string>() })
  })

  it('多覆盖层聚合：任一打开即占位，全部释放才关闭', () => {
    expect(useModalOverlayStore.getState().openKeys.size).toBe(0)
    useModalOverlayStore.getState().setOverlayOpen('a', true)
    useModalOverlayStore.getState().setOverlayOpen('b', true)
    expect(useModalOverlayStore.getState().openKeys.size).toBe(2)
    useModalOverlayStore.getState().setOverlayOpen('a', false)
    expect(useModalOverlayStore.getState().openKeys.size).toBe(1)
    useModalOverlayStore.getState().setOverlayOpen('b', false)
    expect(useModalOverlayStore.getState().openKeys.size).toBe(0)
  })

  it('同一 key 重复声明不产生重复槽位', () => {
    useModalOverlayStore.getState().setOverlayOpen('a', true)
    useModalOverlayStore.getState().setOverlayOpen('a', true)
    expect(useModalOverlayStore.getState().openKeys.size).toBe(1)
  })

  it('veil 卸载自动释放槽位', () => {
    const { unmount } = render(() => <Probe id="probe" open />)
    expect(useModalOverlayStore.getState().openKeys.has('probe')).toBe(true)
    unmount()
    expect(useModalOverlayStore.getState().openKeys.has('probe')).toBe(false)
  })
})
