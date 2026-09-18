import type { ComponentType } from 'react'
import type { AgentSidebarContributionProps } from '../../plugin-runtime/sidebar/sidebarTypes.ts'

/**
 * 第一方贡献的窄渲染器。`component` 在运行时边界是不透明值（`unknown`），
 * 只有这里收窄成组件类型——`first-party-react` 只供主构建内置插件使用，
 * 因此这层 `as` 是本仓既定边界，不是逃生舱。
 */
export function FirstPartyContribution({ component, props }: { component: unknown; props: AgentSidebarContributionProps }) {
  const Component = component as ComponentType<AgentSidebarContributionProps>
  return <Component {...props} />
}
