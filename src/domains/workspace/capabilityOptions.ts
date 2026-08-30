export type CapabilityKind = 'mcp' | 'skill' | 'hook-plugin'

export interface CapabilityOption {
  readonly kind: CapabilityKind
  readonly id: string
  readonly label: string
  readonly source: string
  readonly enabled: boolean
  readonly available: boolean
  readonly diagnostic?: string
}

/**
 * Map persisted ids onto currently discoverable options without dropping
 * dangling references. The latter remain visible as unavailable so a user can
 * repair configuration instead of silently changing a future session.
 */
export function buildCapabilityOptions(
  kind: CapabilityKind,
  available: readonly { id: string; label?: string; source?: string }[],
  selectedIds: readonly string[],
): readonly CapabilityOption[] {
  const selected = new Set(selectedIds)
  const seen = new Set<string>()
  const options: CapabilityOption[] = []
  for (const item of available) {
    const id = item.id.trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    options.push({
      kind,
      id,
      label: item.label?.trim() || id,
      source: item.source?.trim() || 'registry',
      enabled: selected.has(id),
      available: true,
    })
  }
  for (const id of selectedIds) {
    const normalized = id.trim()
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    options.push({
      kind,
      id: normalized,
      label: normalized,
      source: 'persisted',
      enabled: true,
      available: false,
      diagnostic: '当前来源未提供此能力',
    })
  }
  return options
}

