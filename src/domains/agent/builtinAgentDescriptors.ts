import type { AgentDescriptor } from './agentContracts.ts'
import { registerAgentDescriptor } from './agentRegistry.ts'
import { builtinAgentCatalog } from './agentCatalog.ts'

/** 内置原生 ACP agent 描述符基线；adapter 插件与 registry 共用同一数据源。 */
export const BUILTIN_AGENT_DESCRIPTORS: readonly AgentDescriptor[] = builtinAgentCatalog.descriptors()

export function registerBuiltinAgentDescriptors(): void {
  for (const descriptor of BUILTIN_AGENT_DESCRIPTORS) registerAgentDescriptor(descriptor)
}
