import type { AgentEntry } from '../../domains/agent/agentEntry.ts'
import type { PluginServiceRegistry } from '../../plugin-runtime/services/pluginServiceRegistry.ts'

export const AGENT_INSTANCE_SINK_ID = 'pylon.agent-instances'
export const TOOL_DICTIONARY_SINK_ID = 'pylon.tool-dictionary'

export interface AgentInstanceSink {
  apply(entries: readonly AgentEntry[]): void
}

export interface ToolDictionarySink {
  apply(dictionary: unknown): void
}

export function applyAgentInstancesThroughPort(
  registry: PluginServiceRegistry,
  entries: readonly AgentEntry[],
): void {
  registry.resolveRequired<AgentInstanceSink>('agent-instance-sink', AGENT_INSTANCE_SINK_ID).apply(entries)
}

export function applyToolDictionaryThroughPort(
  registry: PluginServiceRegistry,
  dictionary: unknown,
): void {
  registry.resolveRequired<ToolDictionarySink>('tool-dictionary-sink', TOOL_DICTIONARY_SINK_ID).apply(dictionary)
}
