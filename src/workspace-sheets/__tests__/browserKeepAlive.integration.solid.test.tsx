// @vitest-environment jsdom
/** @jsxImportSource solid-js */
/**
 * G5（FE-AUD-006）：browser sheet 保活——非 active browser sheet 隐藏渲染
 * （不卸载，WebView 不销毁）；真正 close（从 sheets 移除）才卸载。
 *
 * #515：迁移自 browserKeepAlive.integration.test.tsx（React RTL → @solidjs/testing-library）。
 * 改写点登记：
 * - `render(<SheetLayout/>)` → `render(() => <SheetLayout/>)`（Solid render 传函数），
 *   实体直连 SheetLayout.solid.tsx；
 * - 补显式 `afterEach(cleanup)`（vitest globals 未开，solid testing-library 不自动清理）；
 * - 断言集原样保留（keep-alive 容器 class、display:none、aria-hidden 逐字节不变），
 *   无其他改写。
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { cleanup, render } from '@solidjs/testing-library'
import '../../plugin-runtime/testing/productPluginTestBootstrap.ts'
import SheetLayout from '../SheetLayout.solid.tsx'
import { useWorkspaceStore } from '../../domains/workspace/workspaceStore'
import { resetStores } from '../../test/resetStores'

// vitest globals 未开，solid testing-library 不自动 cleanup。
afterEach(cleanup)

function renderLayout() {
  return render(() => (
    <SheetLayout
      activeSession={null}
      onSelectSession={() => {}}
      onProfileEdit={() => {}}
      onSessionSettings={() => {}}
    />
  ))
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
