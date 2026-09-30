import type { AgentEntry } from '../../domains/identity/identityStore'
import type { AgentCreateConfig, AgentsConfigDocument } from '../../infrastructure/acp/agentClient'

export interface Draft {
  name: string
  exe: string
  provider: string
  args: string[]
  effectiveSuffix: string[]
  argsKnown: boolean
}

export function emptyDraft(agent?: AgentEntry): Draft {
  const args = agent?.args ? [...agent.args] : []
  const effectiveArgs = agent?.effectiveArgs ?? args
  const hasMatchingPrefix = args.every((argument, index) => effectiveArgs[index] === argument)
  return {
    name: agent?.name ?? '',
    exe: agent?.exe ?? '',
    provider: agent?.provider ?? '',
    args,
    effectiveSuffix: hasMatchingPrefix ? effectiveArgs.slice(args.length) : [],
    argsKnown: agent?.args !== undefined,
  }
}

export function agentConfig(name: string, exe: string, args: readonly string[], provider: string, isFirst: boolean): AgentCreateConfig {
  return {
    name: name.trim(),
    provider: provider.trim() || 'custom',
    transport: 'subprocess',
    exe: exe.trim(),
    args: [...args],
    default: isFirst,
  }
}

export function agentsDocument(id: string, config: AgentCreateConfig): AgentsConfigDocument {
  return { agents: { [id]: config } }
}
