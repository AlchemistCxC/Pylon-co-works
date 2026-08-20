import type { AgentEntry } from '../../domains/agent/agentEntry.ts'
import {
  replaceAgentInstances,
  registerAgentDescriptor,
  unregisterAgentDescriptorProvider,
} from '../../domains/agent/agentRegistry.ts'
import { BUILTIN_AGENT_DESCRIPTORS } from '../../domains/agent/builtinAgentDescriptors.ts'
import { BUILTIN_SESSION_STATE_SYNC_PROVIDER } from '../core/sessionState/runtimeStoreSessionState.ts'
import type { BuiltinPluginDefinition } from '../../plugin-runtime/pluginRuntime.ts'
import { createSharedLogicalActivation } from './sharedLogicalActivation.ts'
import { BUILTIN_PYLON_AGENT_ADAPTERS_ID } from './productPluginIds.ts'
import { BUILTIN_AGENT_DETECTORS } from '../../domains/agent/agentDetector.ts'
import { registerBuiltinSessionCreationContributions } from '../core/sessionCreation/builtinSessionCreation.ts'
import {
  AGENT_INSTANCE_SINK_ID,
  type AgentInstanceSink,
} from '../../app/ports/productContributionPorts.ts'

let latestAgentEntries: readonly AgentEntry[] = Object.freeze([])
let active = false

const bindAgentAdapters = createSharedLogicalActivation(
  () => {
    active = true
    for (const descriptor of BUILTIN_AGENT_DESCRIPTORS) {
      registerAgentDescriptor(descriptor, { registerTools: false })
    }
    if (latestAgentEntries.length > 0) replaceAgentInstances(latestAgentEntries)
  },
  () => {
    active = false
    replaceAgentInstances([])
    for (const descriptor of BUILTIN_AGENT_DESCRIPTORS) {
      unregisterAgentDescriptorProvider(descriptor.provider)
    }
  },
)

/** Runtime agent instances are input data owned by the logical adapter plugin. */
export function applyPylonAgentInstances(entries: readonly AgentEntry[]): void {
  latestAgentEntries = Object.freeze(entries.map(entry => ({ ...entry })))
  if (active) replaceAgentInstances(latestAgentEntries)
}

export function createBuiltinPylonAgentAdaptersPlugin(): BuiltinPluginDefinition {
  return {
    id: BUILTIN_PYLON_AGENT_ADAPTERS_ID,
    kind: 'agent-adapter',
    firstParty: true,
    hotSwapMode: 'parallel',
    activate: ({ identity, scope, services, sessionCreation }) => {
      bindAgentAdapters(scope, identity.key)
      registerBuiltinSessionCreationContributions(sessionCreation)
      services.register(
        'session-state',
        BUILTIN_SESSION_STATE_SYNC_PROVIDER.providerId,
        BUILTIN_SESSION_STATE_SYNC_PROVIDER,
      )
      services.register<AgentInstanceSink>(
        'agent-instance-sink',
        AGENT_INSTANCE_SINK_ID,
        Object.freeze({ apply: applyPylonAgentInstances }),
      )
      for (const detector of BUILTIN_AGENT_DETECTORS) services.register('agent-detector', detector.id, detector)
    },
  }
}
