import { Suspense, type ComponentType } from 'react'
import { createRoot } from 'react-dom/client'
import { IsolatedPluginSurface } from '../../plugin-runtime/ui/IsolatedPluginSurface.tsx'
import { PluginContributionBoundary } from '../../plugin-runtime/ui/PluginContributionBoundary.tsx'
import { FirstPartyContribution } from './FirstPartyContribution.tsx'
import type { AgentSidebarContributionProps } from '../../plugin-runtime/sidebar/sidebarTypes.ts'
import type { AgentSheetPagePluginIslandInput } from './sidebarBridgeTypes.ts'

/**
 * AgentSheetPagePluginIsland — Solid 主区整页宿主内的**插件贡献 React 岛**（#515）。
 *
 * 页面头部（返回 + 标题）由 Solid 实体渲染；本岛只承载**内容**——两类贡献的渲染面
 * 都在 React 运行时：first-party 组件走 `FirstPartyContribution`（含 Suspense），
 * isolated-surface 走 `IsolatedPluginSurface`；外层统一 `PluginContributionBoundary`。
 * 依赖（贡献投影/共享 props/wire 输入）变化由 Solid 侧 effect 调 `rerender()`。
 * 同族先例：`WorkspaceTitlebarPluginIsland`。
 */
export function mountAgentSheetPageIsland(
  container: HTMLElement,
  get: () => AgentSheetPagePluginIslandInput,
): { rerender(): void; dispose(): void } {
  const root = createRoot(container)
  const renderNow = () => {
    const input = get()
    if (input.renderKind === 'isolated-surface') {
      if (!input.surfaceId) return
      root.render(
        <PluginContributionBoundary contributionId={input.contributionId}>
          <IsolatedPluginSurface
            surfaceId={input.surfaceId}
            className="agent-sheet-page-surface"
            input={input.surfaceInput}
            onEvent={input.onSurfaceEvent}
          />
        </PluginContributionBoundary>,
      )
      return
    }
    const Contribution = input.component as ComponentType<AgentSidebarContributionProps> | undefined
    if (!Contribution || !input.contributionProps) return
    root.render(
      <PluginContributionBoundary contributionId={input.contributionId}>
        <Suspense fallback={null}>
          <FirstPartyContribution component={Contribution} props={input.contributionProps} />
        </Suspense>
      </PluginContributionBoundary>,
    )
  }
  renderNow()
  return {
    rerender: renderNow,
    // 卸载延迟到宏任务：本 dispose 由 Solid onCleanup 触发，而那可能发生在 React 宿主树
    // 的卸载流程内——同步 root.unmount() 会撞 React「渲染期同步卸载」告警（测试白名单
    // 硬断言）。容器随宿主子树一起移除，延迟卸载无泄漏面。
    dispose: () => {
      const rootToUnmount = root
      setTimeout(() => rootToUnmount.unmount(), 0)
    },
  }
}
