export interface SettingsTarget {
  readonly namespace: 'theme' | 'kind' | 'slot' | 'suite' | 'plugin-page' | 'context-panel'
  readonly ownerId: string
  readonly ownerPluginId?: string
  readonly fieldKey: string
}

const NAMESPACES = new Set<SettingsTarget['namespace']>(['theme', 'kind', 'slot', 'suite', 'plugin-page', 'context-panel'])

export function validateSettingsTarget(target: SettingsTarget): SettingsTarget {
  if (!target || !NAMESPACES.has(target.namespace)) throw new Error('Settings target namespace 非法')
  if (!target.ownerId.trim()) throw new Error('Settings target ownerId 不能为空')
  if (!target.fieldKey.trim()) throw new Error('Settings target fieldKey 不能为空')
  if (target.ownerPluginId !== undefined && !target.ownerPluginId.trim()) throw new Error('Settings target ownerPluginId 不能为空')
  return Object.freeze({ ...target })
}

/** Structured targets are canonical; dotted strings are legacy-only and fail closed when ambiguous. */
export function stringifySettingsTarget(target: SettingsTarget): string {
  const normalized = validateSettingsTarget(target)
  const encode = (value: string) => encodeURIComponent(value).replaceAll('.', '%2E')
  // Theme keeps its historical two-segment wire form (`theme.<field>`).
  // The structured owner remains `theme` internally and is restored by parse.
  if (normalized.namespace === 'theme' && normalized.ownerId === 'theme') {
    return ['theme', encode(normalized.fieldKey)].join('.')
  }
  const parts: string[] = [normalized.namespace]
  if (normalized.ownerPluginId !== undefined) parts.push(encode(normalized.ownerPluginId))
  parts.push(encode(normalized.ownerId), encode(normalized.fieldKey))
  return parts.join('.')
}

export function parseSettingsTarget(value: string): SettingsTarget | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined
  const parts = value.split('.')
  const namespace = parts[0] as SettingsTarget['namespace']
  if (!NAMESPACES.has(namespace)) return undefined
  try {
    // Legacy theme targets are intentionally two segments; accepting a
    // `theme.theme.<field>` form would create a second identity.
    if (namespace === 'theme' && parts.length === 2) {
      const fieldKey = decodeURIComponent(parts[1])
      return fieldKey ? validateSettingsTarget({ namespace, ownerId: 'theme', fieldKey }) : undefined
    }
    if (parts.length !== 3 && parts.length !== 4) return undefined
    const decode = (part: string) => decodeURIComponent(part)
    const ownerPluginId = parts.length === 4 ? decode(parts[1]) : undefined
    const ownerPart = parts.length === 4 ? parts[2] : parts[1]
    const fieldPart = parts.length === 4 ? parts[3] : parts[2]
    const ownerId = decode(ownerPart)
    const fieldKey = decode(fieldPart)
    if (!ownerId || !fieldKey || ownerId === 'theme' && namespace === 'theme') return undefined
    return validateSettingsTarget({ namespace, ownerId, fieldKey, ...(ownerPluginId ? { ownerPluginId } : {}) })
  } catch { return undefined }
}
