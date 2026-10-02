import type { AgentSidebarContributionProps } from '../../plugin-runtime/sidebar/sidebarTypes.ts'

/** 除逐区块字段（`presentation` / `collapsed` / 动作注册）之外的贡献 props。 */
export type AgentSidebarSharedProps = Omit<
  AgentSidebarContributionProps,
  'presentation' | 'collapsed' | 'onBlockAction' | 'registerBlockActionHandler'
>

/**
 * 贡献 props 的接线契约。
 *
 * 历史上这里是 React hook `useSidebarContributionProps`（Sidebar 与页面宿主的
 * 「唯一接线处」——两处必须拿到同一批会话/工作区数据与回调，否则「整页里删掉的
 * 会话，区块里还显示」这类分裂迟早会出现）。
 *
 * #515：hook 无剩余 React 消费者，已删除；Solid 侧接线内联在两个消费实体里，
 * 语义逐条对齐（`Sidebar.solid.tsx` 与 `sidebar/AgentSheetPageHost.solid.tsx`）。
 * 本文件只保留两侧共享的 `AgentSidebarSharedProps` 类型面。
 */
