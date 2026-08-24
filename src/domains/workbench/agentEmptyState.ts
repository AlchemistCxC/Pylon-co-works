export interface AgentEmptyStateModel {
  readonly eyebrow: string
  readonly title: string
  readonly description: string
  readonly steps: readonly [string, string]
}

/** Framework-neutral copy model shared by every first-party Agent workbench. */
export function selectAgentEmptyState(workspaceMode: 'work' | 'chat'): AgentEmptyStateModel {
  if (workspaceMode === 'chat') {
    return Object.freeze({
      eyebrow: 'AGENT CHAT',
      title: '准备开始',
      description: '从左栏进入一段对话，消息、工具调用和运行状态会在这里持续呈现。',
      steps: ['选择已有聊天', '点击 + 新建聊天'] as const,
    })
  }
  return Object.freeze({
    eyebrow: 'AGENT WORKSPACE',
    title: '准备开始',
    description: '从左栏建立工作上下文，然后让 Agent 在对应会话中继续任务。',
    steps: ['选择或创建工作区', '创建或选择会话'] as const,
  })
}
