import { Suspense, type ComponentType } from 'react'
import { createRoot } from 'react-dom/client'
import { IsolatedPluginSurface } from '../plugin-runtime/ui/IsolatedPluginSurface.tsx'
import { PluginContributionBoundary } from '../plugin-runtime/ui/PluginContributionBoundary.tsx'
import type { TitlebarContext } from '../plugin-runtime/titlebar/titlebarTypes.ts'

/**
 * WorkspaceTitlebarPluginIsland — Solid 标题栏内的插件贡献 React 岛（#279 第 3 梯队）。
 *
 * 标题栏的 app-actions 插件贡献按插件 API 是 React 面：component 渲染种类是任意 React
 * 组件，并依赖 React 的 ErrorBoundary（PluginContributionBoundary）与 Suspense——只存在
 * 于 React 运行时。Solid 化的标题栏经 `mountTitlebarPluginIsland` 把这一簇留在 React
 * root 里；依赖变化由 Solid 侧 effect 调 `rerender()`（React 自 diff，不重挂）。
 */

/** 与 titlebarRegistry 快照条目结构一致（宿主侧已过滤出 app-actions 槽位）。 */
export interface TitlebarPluginActionEntry {
  contributionId: string
  value: {
    renderKind: string
    surfaceId?: string
    component?: ComponentType<{ context: TitlebarContext }>
  }
}

export interface TitlebarPluginIslandInput {
  entries: TitlebarPluginActionEntry[]
  context: TitlebarContext
}

export function mountTitlebarPluginIsland(
  container: HTMLElement,
  get: () => TitlebarPluginIslandInput,
): { rerender(): void; dispose(): void } {
  const root = createRoot(container)
  const renderNow = () => {
    const { entries, context } = get()
    root.render(
      <>
        {entries.map(entry => {
          const contribution = entry.value
          // 菜单项不进标题栏按钮簇：它是数据化贡献，渲染在齿轮菜单里。
          if (contribution.renderKind === 'command') return null
          if (contribution.renderKind === 'isolated-surface') {
            if (!contribution.surfaceId) return null
            return <IsolatedPluginSurface key={entry.contributionId} surfaceId={contribution.surfaceId} className="workspace-titlebar-plugin-action" input={{ titlebarContext: context }} />
          }
          const Contribution = contribution.component
          if (!Contribution) return null
          return <PluginContributionBoundary key={entry.contributionId} contributionId={entry.contributionId}><Suspense fallback={null}><Contribution context={context} /></Suspense></PluginContributionBoundary>
        })}
      </>
    )
  }
  renderNow()
  return {
    rerender: renderNow,
    // 卸载延迟到宏任务：本 dispose 由 Solid onCleanup 触发，而那发生在 React 宿主树
    // 的卸载流程内——同步 root.unmount() 会撞 React「渲染期同步卸载」告警（测试白名单
    // 硬断言）。容器随宿主子树一起移除，延迟卸载无泄漏面。
    dispose: () => {
      const rootToUnmount = root
      setTimeout(() => rootToUnmount.unmount(), 0)
    },
  }
}
