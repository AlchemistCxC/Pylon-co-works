import type { AgentEntry } from '../../identityStore.ts'
import type { AgentConnectionTestResult } from '../../infrastructure/acp/agentClient.ts'

export interface ProvisionAgentInput {
  candidateId: string
  agentId: string
  name: string
  provider: string
  executable: string
  args: string[]
}

export interface ProvisionAgentDeps {
  validate: (input: ProvisionAgentInput) => Promise<AgentConnectionTestResult>
  persist: (input: ProvisionAgentInput) => Promise<void>
  refreshAgents: () => Promise<AgentEntry[]>
  applyAgents: (agents: AgentEntry[]) => void
  activate: (agentId: string, agentName: string) => Promise<boolean>
}

export interface ProvisionAgentOptions {
  /** UI 已展示并保存的验证结果；复用它可避免候选进程被启动两次。 */
  validation?: AgentConnectionTestResult
  /** 仅供入口已经显式确认的高置信候选使用。 */
  acceptUnverified?: boolean
  /** CLI 等无界面入口只导入配置，不改变当前 live runtime。 */
  activate?: boolean
}

export type ProvisionAgentResult =
  | { kind: 'ready'; agentId: string; validation: AgentConnectionTestResult }
  | { kind: 'validation-failed'; agentId: string; validation: AgentConnectionTestResult }
  | { kind: 'stored-not-active'; agentId: string; validation: AgentConnectionTestResult }
  | { kind: 'stored'; agentId: string; validation: AgentConnectionTestResult }

/**
 * Agent 首次供应事务：只有配置已写入、registry 已刷新且 live runtime 已激活，
 * 才能向入口报告 ready。
 */
export async function provisionAgentTransaction(
  input: ProvisionAgentInput,
  deps: ProvisionAgentDeps,
  options: ProvisionAgentOptions = {},
): Promise<ProvisionAgentResult> {
  const validation = options.validation ?? await deps.validate(input)
  if (!validation.ok && !options.acceptUnverified) {
    return { kind: 'validation-failed', agentId: input.agentId, validation }
  }
  await deps.persist(input)
  const agents = await deps.refreshAgents()
  deps.applyAgents(agents)
  if (options.activate === false) {
    return { kind: 'stored', agentId: input.agentId, validation }
  }
  const activated = await deps.activate(input.agentId, input.name)
  if (!activated) {
    return { kind: 'stored-not-active', agentId: input.agentId, validation }
  }
  return { kind: 'ready', agentId: input.agentId, validation }
}
