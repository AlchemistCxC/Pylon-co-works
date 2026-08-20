import type { BuiltinPluginDefinition, PluginRuntime } from './pluginRuntime.ts'

export interface BuiltinPluginBootstrapFailure {
  readonly pluginId: string
  readonly stage: 'activate' | 'dependency'
  readonly code: 'plugin_activation_failed' | 'dependency_failed'
  readonly message: string
  readonly retryable: boolean
}

export interface BuiltinPluginBootstrapResult {
  readonly activePluginIds: readonly string[]
  readonly failures: readonly BuiltinPluginBootstrapFailure[]
  readonly skippedPluginIds: readonly string[]
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export async function bootstrapPluginDefinitions(
  runtime: PluginRuntime,
  definitions: readonly BuiltinPluginDefinition[],
  mode: 'normal' | 'safe-mode',
): Promise<BuiltinPluginBootstrapResult> {
  if (mode === 'safe-mode') {
    const ids = new Set(definitions.map(item => item.id))
    for (const identity of [...runtime.snapshot().active].reverse()) {
      if (ids.has(identity.pluginId)) await runtime.deactivate(identity.key)
    }
    return Object.freeze({
      activePluginIds: Object.freeze(runtime.snapshot().active.map(item => item.pluginId).sort()),
      failures: Object.freeze([]),
      skippedPluginIds: Object.freeze(definitions.map(item => item.id).sort()),
    })
  }

  const active = new Set(runtime.snapshot().active.map(item => item.pluginId))
  const failures: BuiltinPluginBootstrapFailure[] = []
  const skipped: string[] = []
  for (const definition of definitions) {
    if (active.has(definition.id)) continue
    const unavailable = Object.keys(definition.dependencies ?? {}).filter(dependency => !active.has(dependency))
    if (unavailable.length > 0) {
      skipped.push(definition.id)
      failures.push(Object.freeze({
        pluginId: definition.id,
        stage: 'dependency',
        code: 'dependency_failed',
        message: `依赖未激活：${unavailable.join(', ')}`,
        retryable: true,
      }))
      continue
    }
    try {
      if (definition.version && definition.packageInstanceId) await runtime.activatePackage(definition)
      else await runtime.activateBuiltin(definition)
      active.add(definition.id)
    } catch (error) {
      failures.push(Object.freeze({
        pluginId: definition.id,
        stage: 'activate',
        code: 'plugin_activation_failed',
        message: messageOf(error),
        retryable: true,
      }))
    }
  }
  return Object.freeze({
    activePluginIds: Object.freeze([...active].sort()),
    failures: Object.freeze(failures),
    skippedPluginIds: Object.freeze(skipped.sort()),
  })
}
