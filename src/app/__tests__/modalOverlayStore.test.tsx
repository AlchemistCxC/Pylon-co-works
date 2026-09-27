// @vitest-environment jsdom
/**
 * #309：模态覆盖层让位事实的聚合语义——任一打开即 open，全部释放才关闭；
 * veil 槽位在卸载时自动释放（覆盖层组件可能条件渲染，卸载路径必须自愈）。
 */
import { act, render } from '@testing-library/react'
import { describe, expect, it, beforeEach } from 'vitest'
import { useModalOverlayStore, useModalOverlayVeil } from '../modalOverlayStore'

function Probe({ id, open }: { id: string; open: boolean }) {
  useModalOverlayVeil(id, open)
  return null
}

describe('modalOverlayStore（#309）', () => {
  beforeEach(() => {
    useModalOverlayStore.setState({ openKeys: new Set<string>() })
  })

  it('多覆盖层聚合：任一打开即占位，全部释放才关闭', () => {
    expect(useModalOverlayStore.getState().openKeys.size).toBe(0)
    act(() => { useModalOverlayStore.getState().setOverlayOpen('a', true) })
    act(() => { useModalOverlayStore.getState().setOverlayOpen('b', true) })
    expect(useModalOverlayStore.getState().openKeys.size).toBe(2)
    act(() => { useModalOverlayStore.getState().setOverlayOpen('a', false) })
    expect(useModalOverlayStore.getState().openKeys.size).toBe(1)
    act(() => { useModalOverlayStore.getState().setOverlayOpen('b', false) })
    expect(useModalOverlayStore.getState().openKeys.size).toBe(0)
  })

  it('同一 key 重复声明不产生重复槽位', () => {
    act(() => { useModalOverlayStore.getState().setOverlayOpen('a', true) })
    act(() => { useModalOverlayStore.getState().setOverlayOpen('a', true) })
    expect(useModalOverlayStore.getState().openKeys.size).toBe(1)
  })

  it('useModalOverlayVeil：卸载即释放槽位', () => {
    const { unmount } = render(<Probe id="probe" open />)
    expect(useModalOverlayStore.getState().openKeys.has('probe')).toBe(true)
    unmount()
    expect(useModalOverlayStore.getState().openKeys.has('probe')).toBe(false)
  })
})
