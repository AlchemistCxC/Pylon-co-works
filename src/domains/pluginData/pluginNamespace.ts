export type PluginDataPlane = 'metadata' | 'context'
export type PluginNamespaceRoot = Record<string, Record<string, unknown>>

export const PLUGIN_NAMESPACE_MAX_BYTES = 64 * 1024

function assertJsonValue(value: unknown, path: string, seen: Set<object>): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${path} 含非有限数字`)
    return
  }
  if (typeof value !== 'object') throw new Error(`${path} 不是 JSON 可序列化值`)
  if (seen.has(value)) throw new Error(`${path} 含循环引用`)
  seen.add(value)
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertJsonValue(item, `${path}[${index}]`, seen))
  } else {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) throw new Error(`${path} 必须是普通对象`)
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (key === '__proto__' || key === 'prototype' || key === 'constructor') {
        throw new Error(`${path} 含保留键 ${key}`)
      }
      assertJsonValue(item, `${path}.${key}`, seen)
    }
  }
  seen.delete(value)
}

export function assertPluginPatch(patch: unknown): asserts patch is Record<string, unknown> {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('插件数据 patch 必须是普通对象')
  assertJsonValue(patch, 'patch', new Set())
}

export function normalizePluginNamespaceRoot(raw: unknown): PluginNamespaceRoot {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const result: PluginNamespaceRoot = {}
  for (const [pluginId, namespace] of Object.entries(raw as Record<string, unknown>)) {
    if (!pluginId || !namespace || typeof namespace !== 'object' || Array.isArray(namespace)) continue
    try {
      assertPluginPatch(namespace)
      result[pluginId] = { ...(namespace as Record<string, unknown>) }
    } catch { /* 损坏的单插件命名空间隔离丢弃，不污染基础模型 */ }
  }
  return result
}

export function mergePluginNamespace(
  metadata: PluginNamespaceRoot,
  context: PluginNamespaceRoot,
  plane: PluginDataPlane,
  pluginId: string,
  patch: Record<string, unknown>,
): { metadata: PluginNamespaceRoot; context: PluginNamespaceRoot } {
  if (!pluginId.trim()) throw new Error('pluginId 不能为空')
  assertPluginPatch(patch)
  const nextNamespace = { ...(plane === 'metadata' ? metadata[pluginId] : context[pluginId]), ...patch }
  const nextMetadata = plane === 'metadata' ? { ...metadata, [pluginId]: nextNamespace } : metadata
  const nextContext = plane === 'context' ? { ...context, [pluginId]: nextNamespace } : context
  const encoded = new TextEncoder().encode(JSON.stringify({
    metadata: nextMetadata[pluginId] ?? {},
    context: nextContext[pluginId] ?? {},
  }))
  if (encoded.byteLength > PLUGIN_NAMESPACE_MAX_BYTES) {
    throw new Error(`插件命名空间超过 ${PLUGIN_NAMESPACE_MAX_BYTES} 字节上限：${pluginId}`)
  }
  return { metadata: nextMetadata, context: nextContext }
}
