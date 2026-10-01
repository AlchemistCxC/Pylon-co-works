import { createRoot } from 'react-dom/client'
import CwdSettingsPanel from '../settings/CwdSettingsPanel'
import type { CwdSettingsIslandInput } from './sidebarBridgeTypes.ts'

/**
 * CwdSettingsIsland — Solid 会话面板内的**工作区设置 React 岛**（#515）。
 *
 * CwdSettingsPanel（settings/**）仍是 React 面（后续批次迁移），Solid 侧 SessionsPanel
 * 的手写 Dialog 经本岛承载它；依赖变化由 Solid 侧调 `rerender()`（React 自 diff）。
 * 同族先例：`WorkspaceTitlebarPluginIsland`。
 */
export function mountCwdSettingsIsland(
  container: HTMLElement,
  get: () => CwdSettingsIslandInput,
): { rerender(): void; dispose(): void } {
  const root = createRoot(container)
  const renderNow = () => {
    const { workspace, onClose } = get()
    root.render(<CwdSettingsPanel workspace={workspace} onClose={onClose} showHeader={false} />)
  }
  renderNow()
  return {
    rerender: renderNow,
    // 卸载延迟到宏任务：本 dispose 由 Solid onCleanup 触发，而那可能发生在宿主卸载流程内
    // ——同步 root.unmount() 会撞 React「渲染期同步卸载」告警（同 WorkspaceTitlebarPluginIsland）。
    dispose: () => {
      const rootToUnmount = root
      setTimeout(() => rootToUnmount.unmount(), 0)
    },
  }
}
