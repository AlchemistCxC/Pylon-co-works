/** @jsxImportSource solid-js */
// @vitest-environment jsdom
/**
 * #309：模态覆盖层让位事实的聚合语义——任一打开即 open，全部释放才关闭；
 * veil 槽位在卸载时自动释放（覆盖层组件可能条件渲染，卸载路径必须自愈）。
 * #515：React Probe（useModalOverlayVeil）→ solid Probe（createEffect + onCleanup，
 * 与 App.solid createVeil / PermissionDialog.solid 的生产内联形态同构）。断言集逐字保留。
 */
import { render } from '@solidjs/testing-library'
import { createEffect, on, onCleanup } from 'solid-js'
import { describe, expect, it, beforeEach } from 'vitest'
import { useModalOverlayStore } from '../modalOverlayStore'

function Probe(props: { id: string; open: boolean }) {
  createEffect(on(() => props.open, isOpen => {
    useModalOverlayStore.getState().setOverlayOpen(props.id, isOpen)
    onCleanup(() => useModalOverlayStore.getState().setOverlayOpen(props.id, false))
  }, { defer: true }))
  return null
}

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

  it('veil 卸载自动释放槽位', () => {
    const { unmount } = render(() => <Probe id="probe" open />)
    expect(useModalOverlayStore.getState().openKeys.has('probe')).toBe(true)
    unmount()
    expect(useModalOverlayStore.getState().openKeys.has('probe')).toBe(false)
  })
})
