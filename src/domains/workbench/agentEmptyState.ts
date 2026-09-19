export interface AgentEmptyStateModel {
  readonly eyebrow: string
  readonly title: string
  readonly description: string
  readonly steps: readonly [string, string]
}

/**
 * Framework-neutral copy model shared by every first-party Agent workbench.
 *
 * 曾经按 `workspaceMode ('work' | 'chat')` 分两套文案——那是「左栏是一对互斥视图」
 * 时代的产物，两套 steps 分别教用户去点对应页签。左栏改为分区堆叠后没有「聊天页签」
 * 可点了，分叉随之取消：只剩这一套通用文案。
 */
export function selectAgentEmptyState(): AgentEmptyStateModel {
  return Object.freeze({
    eyebrow: 'AGENT WORKSPACE',
    title: '准备开始',
    description: '从左栏建立工作上下文，然后让 Agent 在对应会话中继续任务。',
    steps: ['选择或创建工作区', '创建或选择会话'] as const,
  })
}
