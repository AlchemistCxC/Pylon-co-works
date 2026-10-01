import { Suspense, type ComponentType, type LazyExoticComponent } from 'react'
import { createRoot } from 'react-dom/client'
import { IsolatedPluginSurface } from '../../plugin-runtime/ui/IsolatedPluginSurface.tsx'
import { PluginContributionBoundary } from '../../plugin-runtime/ui/PluginContributionBoundary.tsx'
import { RendererSettingsSchemaHost } from '../settings/RendererSettingField.tsx'
import type { ContextPanelContributionProps } from '../../plugin-runtime/context-panel/contextPanelTypes.ts'
import type { ContextPanelSurfaceInput } from '../../plugin-runtime/context-panel/contextPanelSurfaceProtocol.ts'
import type { ContextPanelPluginIslandInput } from './rightPanelTypes.ts'

/**
 * ContextPanelPluginIsland — Solid 右栏宿主内的**插件贡献 React 岛**（#515）。
 *
 * 面板外壳（aside/头部/切换器）由 Solid 实体渲染；本岛只承载**内容**——两类贡献的
 * 渲染面都在 React 运行时（first-party 组件 / IsolatedPluginSurface + Renderer 设置
 * schema 面 + PluginContributionBoundary）。依赖（激活面板/adapter 快照/option 投影/
 * sheet 上下文）变化由 Solid 侧 effect 调 `rerender()`。
 * 同族先例：`WorkspaceTitlebarPluginIsland`。
 */
export function mountContextPanelPluginIsland(
  container: HTMLElement,
  get: () => ContextPanelPluginIslandInput,
): { rerender(): void; dispose(): void } {
  const root = createRoot(container)
  const renderNow = () => {
    const input = get()
    const schemaHost = input.schema ? (
      <RendererSettingsSchemaHost
        schema={input.schema}
        anchorPrefix={`schema:${input.contributionId}`}
        values={input.values}
        unavailable={input.unavailable}
        options={input.schemaOptions}
        onChange={input.onSettingChange}
        onReset={input.onSettingReset}
        onRestoreUnavailable={input.onRestoreUnavailable}
      />
    ) : null
    let body
    if (input.renderKind === 'isolated-surface') {
      if (!input.surfaceId) return
      const surface = (
        <IsolatedPluginSurface
          surfaceId={input.surfaceId}
          className="context-panel-plugin-surface"
          input={{
            workspaceKind: input.sheet.kind,
            sheet: { id: input.sheet.id, kind: input.sheet.kind, title: input.sheet.title, agentId: input.sheet.agentId, metadata: input.sheet.metadata },
            activeSessionId: input.ctx.activeSession,
            values: input.values,
          } satisfies ContextPanelSurfaceInput}
          onEvent={input.onSurfaceEvent}
        />
      )
      body = input.schema ? <>{schemaHost}{surface}</> : surface
    } else {
      const Contribution = input.component as
        | ComponentType<ContextPanelContributionProps>
        | LazyExoticComponent<ComponentType<ContextPanelContributionProps>>
        | undefined
      if (!Contribution) return
      body = <>{schemaHost}<Suspense fallback={null}><Contribution sheet={input.sheet} ctx={input.ctx} /></Suspense></>
    }
    // 键 = owner 运行实例 + 贡献：热替换/停用换实例时整个边界（含错误态）重置。
    root.render(
      <PluginContributionBoundary
        key={`${input.ownerRuntimeInstanceId}:${input.contributionId}`}
        contributionId={input.contributionId}
      >
        {body}
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
