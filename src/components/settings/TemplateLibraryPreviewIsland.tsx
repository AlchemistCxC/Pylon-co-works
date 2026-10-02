import { createRoot } from 'react-dom/client'
import SettingsPreview from '../SettingsPreview'

/**
 * TemplateLibraryPreviewIsland — Solid 模板库卡片内的 SettingsPreview React 岛
 * （#515：TemplateLibrary 实体迁 .solid.tsx 后，其预览仍由 SettingsPreview（React 面，
 * 内部自挂 Solid 中控）承担）。zone 固定 global，挂载后无 props 流，无需 rerender。
 */

export interface TemplatePreviewIslandInput {
  zone: string
}

export function mountTemplatePreviewIsland(
  container: HTMLElement,
  get: () => TemplatePreviewIslandInput,
): { rerender(): void; dispose(): void } {
  const root = createRoot(container)
  const renderNow = () => {
    root.render(<SettingsPreview zone={get().zone} />)
  }
  renderNow()
  return {
    rerender: renderNow,
    // 卸载延迟到宏任务：本 dispose 由 Solid onCleanup 触发（与 WorkspaceTitlebarPluginIsland
    // 同款处理，规避 React「渲染期同步卸载」告警）。容器随宿主子树一起移除，延迟卸载无泄漏面。
    dispose: () => {
      const rootToUnmount = root
      setTimeout(() => rootToUnmount.unmount(), 0)
    },
  }
}
