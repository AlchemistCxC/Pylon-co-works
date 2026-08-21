import {
  applyToolRegistryOverlay,
  removeToolRegistryOverlay,
} from '../../domains/tool/toolRegistry.ts'
import { createBuiltinCommandDefinitions } from '../core/commandSet/builtinCommandExecutors.ts'
import type { BuiltinPluginDefinition } from '../../plugin-runtime/pluginRuntime.ts'
import { createSharedLogicalActivation } from './sharedLogicalActivation.ts'
import { BUILTIN_PYLON_TOOLS_ID } from './productPluginIds.ts'
import {
  TOOL_DICTIONARY_SINK_ID,
  type ToolDictionarySink,
} from '../../app/ports/productContributionPorts.ts'

let latestDictionary: unknown
let active = false

const bindToolDictionary = createSharedLogicalActivation(
  () => {
    active = true
    if (latestDictionary !== undefined) applyToolRegistryOverlay(BUILTIN_PYLON_TOOLS_ID, 'runtime-discovery', latestDictionary)
  },
  () => {
    active = false
    removeToolRegistryOverlay(BUILTIN_PYLON_TOOLS_ID, 'runtime-discovery')
  },
)

/** Backend-provided tool dictionaries update only the active logical tools plugin. */
export function applyPylonToolDictionary(dictionary: unknown): void {
  latestDictionary = dictionary
  if (!active) return
  applyToolRegistryOverlay(BUILTIN_PYLON_TOOLS_ID, 'runtime-discovery', dictionary)
}

export function createBuiltinPylonToolsPlugin(): BuiltinPluginDefinition {
  return {
    id: BUILTIN_PYLON_TOOLS_ID,
    kind: 'tool-provider',
    firstParty: true,
    hotSwapMode: 'parallel',
    activate: context => {
      bindToolDictionary(context.scope, context.identity.key)
      context.services.register<ToolDictionarySink>(
        'tool-dictionary-sink',
        TOOL_DICTIONARY_SINK_ID,
        Object.freeze({ apply: applyPylonToolDictionary }),
      )
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
