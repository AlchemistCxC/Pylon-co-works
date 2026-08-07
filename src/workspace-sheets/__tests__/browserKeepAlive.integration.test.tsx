// @vitest-environment jsdom
/**
 * G5（FE-AUD-006）：browser sheet 保活——非 active browser sheet 隐藏渲染
 * （不卸载，WebView 不销毁）；真正 close（从 sheets 移除）才卸载。
 */
import { describe, expect, it, beforeEach } from 'vitest'
import { render } from '@testing-library/react'
import SheetLayout from '../SheetLayout'
import { useWorkspaceStore } from '../../workspaceStore'
import { resetStores } from '../../test/resetStores'

function renderLayout() {
  return render(
    <SheetLayout
      activeSession={null}
      onSelectSession={() => {}}
      onProfileEdit={() => {}}
      onSessionSettings={() => {}}
      rightInset={0}
    />,
  )
}

describe('G5 Browser 保活', () => {
  beforeEach(() => {
    localStorage.clear()
    resetStores()
  })

  it('非 active browser sheet 隐藏渲染（保活容器存在，不卸载）', () => {
    // 预置：agent sheet active + browser sheet 非 active
    const agentId = useWorkspaceStore.getState().openSheet({ kind: 'agent', agentId: 'peri', title: 'Peri' })
    const browserId = useWorkspaceStore.getState().openSheet({ kind: 'browser', title: 'Browser' })
    expect(agentId).not.toBeNull()
    expect(browserId).not.toBeNull()
    useWorkspaceStore.getState().focusSheet(agentId!)
    const { container } = renderLayout()
    // 保活隐藏容器存在（display:none + aria-hidden），browser 组件仍挂载
    // 保活隐藏容器存在（className + display:none），browser 组件仍挂载
    const keptAlive = container.querySelector('.browser-keep-alive') as HTMLElement | null
    expect(keptAlive).toBeTruthy()
    expect(keptAlive?.style.display).toBe('none')
  })

  it('active browser sheet 正常渲染（无保活容器）', () => {
    useWorkspaceStore.getState().openSheet({ kind: 'browser', title: 'Browser' })
    const { container } = renderLayout()
    expect(container.querySelector('[aria-hidden="true"]')).toBeNull()
  })
})
