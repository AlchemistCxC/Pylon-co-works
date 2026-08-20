import {
  BUILTIN_TOOL_REGISTRY,
  registerToolDictionary,
  registerToolRegistryEntries,
  unregisterToolRegistryProvider,
} from '../../domains/tool/toolRegistry.ts'
import { createBuiltinCommandDefinitions } from '../core/commandSet/builtinCommandExecutors.ts'
import type { BuiltinPluginDefinition } from '../../plugin-runtime/pluginRuntime.ts'
import { createSharedLogicalActivation } from './sharedLogicalActivation.ts'
import { BUILTIN_PYLON_TOOLS_ID } from './productPluginIds.ts'

const BUILTIN_TOOL_PROVIDERS = Object.freeze([
  ...new Set(BUILTIN_TOOL_REGISTRY.map(entry => entry.provider)),
])
let latestDictionary: unknown
let active = false

function registerEffectiveDictionary(): void {
  registerToolRegistryEntries(BUILTIN_TOOL_REGISTRY)
  if (latestDictionary !== undefined) registerToolDictionary(latestDictionary)
}

function clearEffectiveDictionary(): void {
  for (const provider of BUILTIN_TOOL_PROVIDERS) unregisterToolRegistryProvider(provider)
}

const bindToolDictionary = createSharedLogicalActivation(
  () => {
    active = true
    registerEffectiveDictionary()
  },
  () => {
    active = false
    clearEffectiveDictionary()
  },
)

/** Backend-provided tool dictionaries update only the active logical tools plugin. */
export function applyPylonToolDictionary(dictionary: unknown): void {
  latestDictionary = dictionary
  if (!active) return
  clearEffectiveDictionary()
  registerEffectiveDictionary()
}

export function createBuiltinPylonToolsPlugin(): BuiltinPluginDefinition {
  return {
    id: BUILTIN_PYLON_TOOLS_ID,
    kind: 'tool-provider',
    firstParty: true,
    hotSwapMode: 'parallel',
    activate: context => {
      bindToolDictionary(context.scope, context.identity.key)
      for (const command of createBuiltinCommandDefinitions()) {
        context.commands.register(command, {
          contributionId: `${BUILTIN_PYLON_TOOLS_ID}.${command.name}`,
          layer: 'platform',
          priority: command.priority,
        })
      }
    },
  }
}
