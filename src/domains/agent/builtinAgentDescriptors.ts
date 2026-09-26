import type { AgentDescriptor } from './agentContracts.ts'
import { builtinAgentCatalog } from './agentCatalog.ts'

/** 内置原生 ACP agent 描述符基线；adapter 插件与 registry 共用同一数据源。
 *  注册由 plugins/product 的 adapter 插件激活生命周期接管（registerTools:false +
 *  unregisterAgentDescriptorProvider 配对），此处不提供一次性批量注册入口。 */
export const BUILTIN_AGENT_DESCRIPTORS: readonly AgentDescriptor[] = builtinAgentCatalog.descriptors()
