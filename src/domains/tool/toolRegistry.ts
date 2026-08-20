import type { ToolAction, ToolKind, ToolProvider } from './toolKinds.ts'
import { builtinAgentCatalog } from '../agent/agentCatalog.ts'

export interface ToolRegistryEntry {
  provider: string
  name: string
  aliases?: readonly string[]
  /** 跨 provider 统一显示名；缺省回退 name。 */
  displayName?: string
  kind: ToolKind
  action: ToolAction
  summaryFields?: readonly string[]
  outputLabel?: 'lines' | 'matches' | 'changed-lines'
}

const registry = new Map<string, Map<string, ToolRegistryEntry>>()

const TOOL_KIND_VALUES: readonly ToolKind[] = ['read', 'edit', 'execute', 'search', 'fetch', 'think', 'other'] as const
const TOOL_ACTION_VALUES: readonly ToolAction[] = ['read', 'write', 'edit', 'search', 'execute', 'fetch', 'navigate', 'click', 'type', 'snapshot', 'delegate', 'plan', 'skill', 'unknown'] as const

function key(value: string): string {
  return value.trim().toLowerCase()
}

export function registerToolRegistryEntry(entry: ToolRegistryEntry): void {
  const provider = entry.provider.trim()
  const name = entry.name.trim()
  if (!provider) throw new Error('Tool registry provider 不能为空')
  if (!name) throw new Error('Tool registry tool name 不能为空')
  const entries = registry.get(provider) ?? new Map<string, ToolRegistryEntry>()
  entries.set(key(name), entry)
  for (const alias of entry.aliases ?? []) {
    if (alias.trim()) entries.set(key(alias), entry)
  }
  registry.set(provider, entries)
}

export function registerToolRegistryEntries(entries: readonly ToolRegistryEntry[]): void {
  for (const entry of entries) registerToolRegistryEntry(entry)
}

export function resolveToolRegistryEntry(provider: string, name: string): ToolRegistryEntry | null {
  const entries = registry.get(provider)
  if (!entries) return null
  return entries.get(key(name)) ?? null
}

export function listToolRegistryEntries(provider?: string): ToolRegistryEntry[] {
  if (provider !== undefined) return uniqueEntries(registry.get(provider)?.values() ?? [])
  return uniqueEntries([...registry.values()].flatMap(entries => [...entries.values()]))
}

export function providersForTool(name: string): string[] {
  return [...registry.entries()]
    .filter(([, entries]) => entries.has(key(name)))
    .map(([provider]) => provider)
}

/** P1-4：按 provider 卸载全部 Tool entries（测试清理与运行时 reload 残留防串）。 */
export function unregisterToolRegistryProvider(provider: string): void {
  registry.delete(provider.trim())
}

export function clearToolRegistryForTests(): void {
  registry.clear()
  // Test-only isolation baseline. Production activation is owned exclusively
  // by builtin.pylon-tools and never calls this helper.
  registerToolRegistryEntries(BUILTIN_TOOL_REGISTRY)
}

/** 后端 list_tool_dictionary 下发字典的 wire 条目（snake_case 字段）。 */
interface ToolDictionaryWireEntry {
  name: string
  aliases?: string[]
  display_name?: string
  kind: ToolKind
  action: ToolAction
  summary_fields?: string[]
  output_label?: 'lines' | 'matches' | 'changed-lines'
}

/** 用后端下发的外置字典覆盖指定 provider 的工具注册项（运行时调试：改 agents.yaml 后 reload 生效）。 */
export function registerToolDictionary(dictionary: unknown): void {
  if (!dictionary || typeof dictionary !== 'object') return
  const map = dictionary as Record<string, unknown>
  for (const [provider, entries] of Object.entries(map)) {
    if (!provider.trim() || !Array.isArray(entries)) continue
    const next: ToolRegistryEntry[] = []
    for (const raw of entries) {
      const entry = raw as ToolDictionaryWireEntry
      if (!entry || typeof entry.name !== 'string' || !entry.name.trim()) continue
      if (!TOOL_KIND_VALUES.includes(entry.kind) || !TOOL_ACTION_VALUES.includes(entry.action)) {
        console.warn(`[toolDictionary] 忽略非法工具项 ${provider}/${entry.name}: kind=${String(entry.kind)} action=${String(entry.action)}`)
        continue
      }
      next.push({
        provider,
        name: entry.name,
        aliases: entry.aliases ?? [],
        displayName: entry.display_name,
        kind: entry.kind,
        action: entry.action,
        summaryFields: entry.summary_fields ?? [],
        outputLabel: entry.output_label,
      })
    }
    if (next.length === 0) continue
    unregisterToolRegistryProvider(provider)
    registerToolRegistryEntries(next)
  }
}

function uniqueEntries(entries: Iterable<ToolRegistryEntry>): ToolRegistryEntry[] {
  return [...new Map([...entries].map(entry => [`${entry.provider}:${key(entry.name)}`, entry])).values()]
}

/** Agent provider 基线来自 Shared Agent Catalog；MCP 是宿主工具协议，不属于 Agent provider。 */
export const BUILTIN_TOOL_REGISTRY: readonly ToolRegistryEntry[] = [
  ...builtinAgentCatalog.tools(),
  { provider: 'mcp', name: 'read_file', displayName: 'Read File', kind: 'read', action: 'read', summaryFields: ['path'] },
  { provider: 'mcp', name: 'browser_navigate', displayName: 'Browser Navigate', kind: 'fetch', action: 'navigate', summaryFields: ['url'] },
]

export type RegisteredToolProvider = ToolProvider | string
