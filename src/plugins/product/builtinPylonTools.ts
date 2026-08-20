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
import {
  TOOL_DICTIONARY_SINK_ID,
  type ToolDictionarySink,
} from '../../app/ports/productContributionPorts.ts'

const BUILTIN_TOOL_PROVIDERS = Object.freeze([
  ...new Set(BUILTIN_TOOL_REGISTRY.map(entry => entry.provider)),
])
let latestDictionary: unknown
let latestDictionaryProviders: readonly string[] = Object.freeze([])
let active = false

function dictionaryProviders(dictionary: unknown): readonly string[] {
  if (!dictionary || typeof dictionary !== 'object' || Array.isArray(dictionary)) return Object.freeze([])
  return Object.freeze(Object.keys(dictionary as Record<string, unknown>).filter(provider => provider.trim()))
}

function registerEffectiveDictionary(): void {
  registerToolRegistryEntries(BUILTIN_TOOL_REGISTRY)
  if (latestDictionary !== undefined) registerToolDictionary(latestDictionary)
}

function clearEffectiveDictionary(): void {
  for (const provider of new Set([...BUILTIN_TOOL_PROVIDERS, ...latestDictionaryProviders])) {
    unregisterToolRegistryProvider(provider)
  }
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
  if (active) clearEffectiveDictionary()
  latestDictionary = dictionary
  latestDictionaryProviders = dictionaryProviders(dictionary)
  if (!active) return
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
