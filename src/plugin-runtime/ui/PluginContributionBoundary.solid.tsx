/** @jsxImportSource solid-js */
import type { JSX } from 'solid-js'
import { ErrorBoundary } from 'solid-js'
import { reportRuntimeError } from '../../app/runtimeError.ts'

/**
 * PluginContributionBoundary — 插件贡献渲染边界（#515 贡献面翻转：Solid 实体，原 React
 * class 组件 PluginContributionBoundary.tsx 同语义移植后删除）。
 *
 * 边界的本地占位是用户可见上下文；崩溃照旧进 Runtime diagnostics（key 去重，不另发
 * 全局 tray error）。占位 DOM（class/role/文案）是存量契约，宿主测试按它断言。
 */
export function PluginContributionBoundary(props: {
  contributionId: string
  children: JSX.Element
}) {
  return (
    <ErrorBoundary fallback={(error) => {
      reportRuntimeError(`渲染插件贡献 ${props.contributionId}`, error instanceof Error ? error : new Error(String(error)), undefined, {
        key: `plugin-contribution:${props.contributionId}`,
        visibility: 'diagnostic',
        scope: { kind: 'operation', id: `plugin-contribution:${props.contributionId}` },
        source: 'plugin.contribution-boundary',
      })
      return <div class="context-panel-placeholder" role="alert">此插件面板暂时不可用</div>
    }}>
      {props.children}
    </ErrorBoundary>
  )
}
