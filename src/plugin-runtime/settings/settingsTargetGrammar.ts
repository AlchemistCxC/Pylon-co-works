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
  return Object.freeze({ ...target })
}

/** Structured targets are canonical; dotted strings are legacy-only and fail closed when ambiguous. */
export function stringifySettingsTarget(target: SettingsTarget): string {
  const normalized = validateSettingsTarget(target)
  const encode = (value: string) => encodeURIComponent(value).replaceAll('.', '%2E')
  return [normalized.namespace, encode(normalized.ownerId), encode(normalized.fieldKey)].join('.')
}

export function parseSettingsTarget(value: string): SettingsTarget | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined
  const parts = value.split('.')
  if (parts.length !== 3 || !NAMESPACES.has(parts[0] as SettingsTarget['namespace'])) return undefined
  try {
    const ownerId = decodeURIComponent(parts[1])
    const fieldKey = decodeURIComponent(parts[2])
    if (!ownerId || !fieldKey) return undefined
    return validateSettingsTarget({ namespace: parts[0] as SettingsTarget['namespace'], ownerId, fieldKey })
  } catch { return undefined }
}
