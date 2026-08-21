import type { ToolAction, ToolKind } from './toolKinds.ts'
import { builtinAgentCatalog } from '../agent/agentCatalog.ts'

export interface ToolRegistryEntry {
  provider: string
  name: string
  aliases?: readonly string[]
  displayName?: string
  kind: ToolKind
  action: ToolAction
  summaryFields?: readonly string[]
  outputLabel?: 'lines' | 'matches' | 'changed-lines'
  capabilities?: readonly string[]
}

export interface ToolRegistryOverlay {
  upsert?: unknown
  remove?: unknown
  aliases?: unknown
}

export interface EffectiveToolDictionary {
  readonly generation: number
  readonly revision: number
  readonly entries: readonly ToolRegistryEntry[]
}

interface OverlaySource {
  readonly id: string
  readonly entries: readonly ToolRegistryEntry[]
  readonly removes: readonly { provider: string; name: string }[]
  readonly aliases: readonly { provider: string; alias: string; target: string }[]
}

const TOOL_KIND_VALUES: readonly ToolKind[] = ['read', 'edit', 'execute', 'search', 'fetch', 'think', 'other']
const TOOL_ACTION_VALUES: readonly ToolAction[] = ['read', 'write', 'edit', 'search', 'execute', 'fetch', 'navigate', 'click', 'type', 'snapshot', 'delegate', 'plan', 'skill', 'unknown']
const key = (value: string): string => value.trim().toLowerCase()

const BUILTIN_TOOL_REGISTRY_INTERNAL: readonly ToolRegistryEntry[] = [
  ...builtinAgentCatalog.tools(),
  { provider: 'mcp', name: 'read_file', displayName: 'Read File', kind: 'read', action: 'read', summaryFields: ['path'] },
  { provider: 'mcp', name: 'browser_navigate', displayName: 'Browser Navigate', kind: 'fetch', action: 'navigate', summaryFields: ['url'] },
]

const manualEntries = new Map<string, ToolRegistryEntry>()
const overlays = new Map<string, OverlaySource>()
let snapshot: EffectiveToolDictionary = Object.freeze({ generation: 0, revision: 0, entries: Object.freeze([]) })
let activeByProvider = new Map<string, Map<string, ToolRegistryEntry>>()
let history = new Map<number, Map<string, Map<string, ToolRegistryEntry>>>()

function cloneEntry(entry: ToolRegistryEntry): ToolRegistryEntry {
  return Object.freeze({
    ...entry,
    provider: entry.provider.trim(),
    name: entry.name.trim(),
    ...(entry.aliases ? { aliases: Object.freeze([...entry.aliases].map(alias => alias.trim()).filter(Boolean)) } : {}),
    ...(entry.summaryFields ? { summaryFields: Object.freeze([...entry.summaryFields]) } : {}),
    ...(entry.capabilities ? { capabilities: Object.freeze([...entry.capabilities]) } : {}),
  })
}

function validateEntry(raw: unknown, providerHint?: string): ToolRegistryEntry {
  if (!raw || typeof raw !== 'object') throw new Error('工具字典条目必须是对象')
  const value = raw as Record<string, unknown>
  const provider = typeof value.provider === 'string' ? value.provider : providerHint
  const name = typeof value.name === 'string' ? value.name : ''
  if (!provider?.trim() || !name.trim()) throw new Error(`工具字典条目缺少 provider/name：${provider ?? ''}/${name}`)
  if (!TOOL_KIND_VALUES.includes(value.kind as ToolKind)) throw new Error(`工具字典非法 kind：${provider}/${name}=${String(value.kind)}`)
  if (!TOOL_ACTION_VALUES.includes(value.action as ToolAction)) throw new Error(`工具字典非法 action：${provider}/${name}=${String(value.action)}`)
  const aliases = value.aliases === undefined ? [] : value.aliases
  if (!Array.isArray(aliases) || aliases.some(alias => typeof alias !== 'string')) throw new Error(`工具字典 aliases 非法：${provider}/${name}`)
  const outputLabel = value.outputLabel ?? value.output_label
  const capabilities = value.capabilities === undefined ? [] : value.capabilities
  if (!Array.isArray(capabilities) || capabilities.some(capability => typeof capability !== 'string' || !capability.trim())) throw new Error(`工具字典 capabilities 非法：${provider}/${name}`)
  return cloneEntry({
    provider: provider.trim().toLowerCase(),
    name: name.trim(),
    aliases: aliases as string[],
    displayName: typeof value.displayName === 'string' ? value.displayName : typeof value.display_name === 'string' ? value.display_name : undefined,
    kind: value.kind as ToolKind,
    action: value.action as ToolAction,
    summaryFields: Array.isArray(value.summaryFields) ? value.summaryFields.filter((item): item is string => typeof item === 'string') : Array.isArray(value.summary_fields) ? value.summary_fields.filter((item): item is string => typeof item === 'string') : [],
    outputLabel: ['lines', 'matches', 'changed-lines'].includes(String(outputLabel)) ? outputLabel as ToolRegistryEntry['outputLabel'] : undefined,
    capabilities: capabilities as string[],
  })
}

function parseOverlay(id: string, dictionary: unknown): OverlaySource {
  if (!dictionary || typeof dictionary !== 'object' || Array.isArray(dictionary)) throw new Error(`工具 overlay 必须是对象：${id}`)
  const root = dictionary as Record<string, unknown>
  const entries: ToolRegistryEntry[] = []
  const removes: { provider: string; name: string }[] = []
  const aliases: { provider: string; alias: string; target: string }[] = []
  const upsert = root.upsert ?? dictionary
  if (upsert && typeof upsert === 'object' && !Array.isArray(upsert)) {
    for (const [provider, rawEntries] of Object.entries(upsert as Record<string, unknown>)) {
      if (['remove', 'aliases', 'upsert', 'owner', 'scope'].includes(provider)) continue
      if (!Array.isArray(rawEntries)) throw new Error(`工具字典 provider 条目必须是数组：${provider}`)
      for (const raw of rawEntries) entries.push(validateEntry(raw, provider))
    }
  } else if (Array.isArray(upsert)) {
    for (const raw of upsert) entries.push(validateEntry(raw))
  }
  if (root.remove !== undefined) {
    const remove = root.remove
    if (Array.isArray(remove)) {
      for (const item of remove) {
        if (typeof item === 'string') {
          const separator = item.indexOf('/')
          if (separator <= 0) throw new Error(`工具 remove 缺少 provider/name：${item}`)
          removes.push({ provider: key(item.slice(0, separator)), name: item.slice(separator + 1).trim() })
        } else if (item && typeof item === 'object') {
          const value = item as Record<string, unknown>
          if (typeof value.provider !== 'string' || typeof value.name !== 'string') throw new Error('工具 remove 条目非法')
          removes.push({ provider: key(value.provider), name: value.name.trim() })
        } else throw new Error('工具 remove 条目非法')
      }
    } else if (remove && typeof remove === 'object') {
      for (const [provider, names] of Object.entries(remove as Record<string, unknown>)) {
        if (!Array.isArray(names) || names.some(name => typeof name !== 'string')) throw new Error(`工具 remove 条目必须是字符串数组：${provider}`)
        for (const name of names as string[]) removes.push({ provider: key(provider), name: name.trim() })
      }
    } else throw new Error('工具 remove 必须是数组或对象')
  }
  if (root.aliases !== undefined) {
    const alias = root.aliases
    if (Array.isArray(alias)) {
      for (const item of alias) {
        if (!item || typeof item !== 'object') throw new Error('工具 aliases 条目非法')
        const value = item as Record<string, unknown>
        if (typeof value.provider !== 'string' || typeof value.alias !== 'string' || typeof value.target !== 'string') throw new Error('工具 aliases 条目缺少 provider/alias/target')
        aliases.push({ provider: key(value.provider), alias: value.alias.trim(), target: value.target.trim() })
      }
    } else if (alias && typeof alias === 'object') {
      for (const [provider, mappings] of Object.entries(alias as Record<string, unknown>)) {
        if (!mappings || typeof mappings !== 'object' || Array.isArray(mappings)) throw new Error(`工具 aliases 映射非法：${provider}`)
        for (const [name, target] of Object.entries(mappings as Record<string, unknown>)) {
          if (typeof target !== 'string') throw new Error(`工具 alias target 非法：${provider}/${name}`)
          aliases.push({ provider: key(provider), alias: name.trim(), target: target.trim() })
        }
      }
    } else throw new Error('工具 aliases 必须是数组或对象')
  }
  const seen = new Set<string>()
  for (const entry of entries) {
    const entryKey = `${entry.provider}:${key(entry.name)}`
    if (seen.has(entryKey)) throw new Error(`工具字典 canonical name 重复：${entry.provider}/${entry.name}`)
    seen.add(entryKey)
  }
  return Object.freeze({ id, entries: Object.freeze(entries), removes: Object.freeze(removes), aliases: Object.freeze(aliases) })
}

function rebuild(): void {
  const next = new Map<string, Map<string, ToolRegistryEntry>>()
  const aliasLinks = new Map<string, { alias: string; target: string }[]>()
  const removedCanonical = new Set<string>()
  const put = (entry: ToolRegistryEntry) => {
    const provider = key(entry.provider)
    const map = next.get(provider) ?? new Map<string, ToolRegistryEntry>()
    map.set(key(entry.name), cloneEntry({ ...entry, provider }))
    next.set(provider, map)
  }
  for (const entry of BUILTIN_TOOL_REGISTRY_INTERNAL) put(entry)
  for (const entry of manualEntries.values()) put(entry)
  for (const source of overlays.values()) {
    for (const item of source.removes) removedCanonical.add(`${item.provider}:${key(item.name)}`)
  }
  for (const source of overlays.values()) {
    for (const item of source.removes) {
      const removed = `${item.provider}:${key(item.name)}`
      removedCanonical.add(removed)
      next.get(item.provider)?.delete(key(item.name))
    }
    for (const entry of source.entries) put(entry)
    for (const item of source.aliases) {
      const links = aliasLinks.get(item.provider) ?? []
      links.push({ alias: key(item.alias), target: key(item.target) })
      aliasLinks.set(item.provider, links)
    }
  }
  for (const [provider, map] of next) {
    const aliases = new Map<string, string>()
    for (const entry of map.values()) {
      for (const alias of entry.aliases ?? []) {
        const aliasKey = key(alias)
        if (map.has(aliasKey) && aliasKey !== key(entry.name)) throw new Error(`工具 alias 与 canonical 冲突：${provider}/${alias}`)
        const prior = aliases.get(aliasKey)
        if (prior && prior !== key(entry.name)) throw new Error(`工具 alias 重复：${provider}/${alias}`)
        aliases.set(aliasKey, key(entry.name))
      }
    }
    for (const link of aliasLinks.get(provider) ?? []) {
      if (!map.has(link.target) && removedCanonical.has(`${provider}:${link.target}`)) continue
      if (map.has(link.alias) && link.alias !== link.target) throw new Error(`工具 alias 与 canonical 冲突：${provider}/${link.alias}`)
      const prior = aliases.get(link.alias)
      if (prior && prior !== link.target) throw new Error(`工具 alias 重复：${provider}/${link.alias}`)
      aliases.set(link.alias, link.target)
    }
    const resolving = new Set<string>()
    const resolved = new Map<string, string>()
    const resolve = (name: string): string => {
      if (map.has(name)) return name
      const cached = resolved.get(name)
      if (cached) return cached
      if (resolving.has(name)) throw new Error(`工具 alias 循环：${provider}/${name}`)
      const target = aliases.get(name)
      if (!target) throw new Error(`工具 alias target 未知：${provider}/${name}`)
      resolving.add(name)
      const canonical = resolve(target)
      resolving.delete(name)
      resolved.set(name, canonical)
      return canonical
    }
    for (const alias of aliases.keys()) resolve(alias)
    for (const [alias, canonical] of aliases) {
      const entry = map.get(canonical)
      if (!entry) throw new Error(`工具 alias target 未知：${provider}/${alias} -> ${canonical}`)
      if (!entry.aliases?.some(item => key(item) === alias)) map.set(canonical, cloneEntry({ ...entry, aliases: [...(entry.aliases ?? []), alias] }))
    }
  }
  const entries = Object.freeze([...next.values()].flatMap(map => [...map.values()].map(cloneEntry)))
  const generation = snapshot.generation + 1
  const revision = snapshot.revision + 1
  snapshot = Object.freeze({ generation, revision, entries })
  activeByProvider = next
  history.set(generation, next)
  if (history.size > 8) history.delete(Math.min(...history.keys()))
}

export const BUILTIN_TOOL_REGISTRY: readonly ToolRegistryEntry[] = BUILTIN_TOOL_REGISTRY_INTERNAL
export function getEffectiveToolDictionary(): EffectiveToolDictionary { return snapshot }
export function getToolDictionaryGeneration(): number { return snapshot.generation }
export function resolveToolSemantic(provider: string, name: string, generation = snapshot.generation): ToolRegistryEntry | null {
  const source = generation === snapshot.generation ? activeByProvider : history.get(generation)
  const entries = source?.get(key(provider))
  if (!entries) return null
  const direct = entries.get(key(name))
  if (direct) return direct
  return [...entries.values()].find(entry => entry.aliases?.some(alias => key(alias) === key(name))) ?? null
}
export function registerToolRegistryEntry(entry: ToolRegistryEntry): void {
  const normalized = validateEntry(entry)
  manualEntries.set(`${normalized.provider}:${key(normalized.name)}`, normalized)
  rebuild()
}
export function registerToolRegistryEntries(entries: readonly ToolRegistryEntry[]): void {
  const normalized = entries.map(entry => validateEntry(entry))
  for (const entry of normalized) manualEntries.set(`${entry.provider}:${key(entry.name)}`, entry)
  rebuild()
}
export function resolveToolRegistryEntry(provider: string, name: string): ToolRegistryEntry | null { return resolveToolSemantic(provider, name) }
export function listToolRegistryEntries(provider?: string): ToolRegistryEntry[] {
  if (provider !== undefined) return [...(activeByProvider.get(key(provider))?.values() ?? [])].map(cloneEntry)
  return [...activeByProvider.values()].flatMap(entries => [...entries.values()].map(cloneEntry))
}
export function providersForTool(name: string): string[] {
  const needle = key(name)
  return [...activeByProvider.entries()]
    .filter(([, entries]) => [...entries.values()].some(entry => key(entry.name) === needle || entry.aliases?.some(alias => key(alias) === needle)))
    .map(([provider]) => provider)
}
export function unregisterToolRegistryProvider(provider: string): void {
  const normalized = key(provider)
  for (const id of [...manualEntries.keys()]) if (id.startsWith(`${normalized}:`)) manualEntries.delete(id)
  for (const [id, source] of overlays) if (source.entries.some(entry => entry.provider === normalized) || source.removes.some(item => item.provider === normalized)) overlays.delete(id)
  rebuild()
}
export function applyToolRegistryOverlay(owner: string, scope: string, overlay: unknown): void {
  const id = `${owner.trim()}::${scope.trim()}`
  if (!owner.trim() || !scope.trim()) throw new Error('工具 overlay owner/scope 不能为空')
  const parsed = parseOverlay(id, overlay)
  const prior = overlays.get(id)
  overlays.set(id, parsed)
  try { rebuild() } catch (error) { if (prior) overlays.set(id, prior); else overlays.delete(id); throw error }
}
export function removeToolRegistryOverlay(owner: string, scope: string): void {
  const id = `${owner.trim()}::${scope.trim()}`
  const prior = overlays.get(id)
  if (!prior) return
  overlays.delete(id)
  try { rebuild() } catch (error) { overlays.set(id, prior); throw error }
}
export function registerToolDictionary(dictionary: unknown, options: { owner?: string; scope?: string } = {}): void {
  applyToolRegistryOverlay(options.owner ?? 'runtime-discovery', options.scope ?? 'global', dictionary)
}
export function clearToolRegistryForTests(): void {
  manualEntries.clear()
  overlays.clear()
  snapshot = Object.freeze({ generation: 0, revision: 0, entries: Object.freeze([]) })
  activeByProvider = new Map()
  history = new Map()
  rebuild()
}

// Catalog baseline is available before any plugin/runtime activation.
rebuild()
