export interface PluginIdentity {
  readonly pluginId: string
  readonly version: string
  readonly packageInstanceId: string
  readonly runtimeInstanceId: string
  /** Migration alias; new code should use runtimeInstanceId. */
  readonly instanceId: string
  /** Registry owner key; identical to runtimeInstanceId. */
  readonly key: string
}

const PLUGIN_ID_PATTERN = /^[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*$/
const INSTANCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

export function createPluginIdentity(pluginId: string, instanceId: string): PluginIdentity {
  if (!PLUGIN_ID_PATTERN.test(pluginId)) {
    throw new Error(`非法 pluginId：${pluginId}`)
  }
  if (!INSTANCE_ID_PATTERN.test(instanceId)) {
    throw new Error(`非法 instanceId：${instanceId}`)
  }
  const runtimeInstanceId = `${pluginId}@${instanceId}`
  return Object.freeze({
    pluginId,
    version: 'builtin',
    packageInstanceId: `${pluginId}@builtin`,
    runtimeInstanceId,
    instanceId,
    key: runtimeInstanceId,
  })
}

export function createPackagePluginIdentity(input: {
  pluginId: string
  version: string
  packageInstanceId: string
  runtimeInstanceId: string
}): PluginIdentity {
  if (!PLUGIN_ID_PATTERN.test(input.pluginId)) throw new Error(`非法 pluginId：${input.pluginId}`)
  if (!input.version.trim()) throw new Error('插件 version 不能为空')
  if (!input.packageInstanceId.startsWith(`${input.pluginId}@`)) {
    throw new Error(`packageInstanceId 与 pluginId 不匹配：${input.packageInstanceId}`)
  }
  if (!input.runtimeInstanceId.startsWith(`${input.packageInstanceId}#`)) {
    throw new Error(`runtimeInstanceId 与 packageInstanceId 不匹配：${input.runtimeInstanceId}`)
  }
  return Object.freeze({
    ...input,
    instanceId: input.runtimeInstanceId,
    key: input.runtimeInstanceId,
  })
}
