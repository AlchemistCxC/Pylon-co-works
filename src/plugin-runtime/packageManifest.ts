import type { BuiltinPluginDefinition } from './pluginRuntime.ts'
import type { HotSwapMode } from './shadowUpdate.ts'

export const PYLON_PLUGIN_API_VERSION = '1.0' as const
export const PYLON_PLUGIN_MANIFEST_FILE = 'pylon-plugin.json' as const

export interface PylonPluginManifest {
  readonly schema: 1
  readonly id: string
  readonly name: string
  readonly version: string
  readonly api: typeof PYLON_PLUGIN_API_VERSION
  readonly kind: NonNullable<BuiltinPluginDefinition['kind']>
  readonly web: {
    readonly entry: string
    readonly styles?: readonly string[]
  }
  readonly executables?: Readonly<Record<string, Readonly<Record<string, string>>>>
  readonly dependencies?: Readonly<Record<string, string>>
  readonly optionalDependencies?: Readonly<Record<string, string>>
  readonly conflicts?: readonly string[]
  readonly activation?: { readonly events: readonly string[] }
  readonly hotSwap?: {
    readonly mode: HotSwapMode
    readonly drainTimeoutMs?: number
  }
  readonly reactVersion?: string
}

const ID_PATTERN = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/
const KINDS = new Set([
  'shell', 'workspace', 'feature', 'hook', 'renderer', 'skin', 'agent-adapter',
  'tool-provider', 'service', 'automation',
])
const HOT_SWAP_MODES = new Set<HotSwapMode>([
  'parallel', 'exclusive', 'soft-remount', 'restart-required',
])

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`pylon-plugin.json ${field} 必须是对象`)
  }
  return value as Record<string, unknown>
}

function stringMap(value: unknown, field: string): void {
  const map = record(value, field)
  for (const [key, entry] of Object.entries(map)) {
    if (typeof entry !== 'string') throw new Error(`pylon-plugin.json ${field}.${key} 必须是字符串`)
  }
}

export function parsePylonPluginManifest(source: string | unknown): PylonPluginManifest {
  const manifest = record(typeof source === 'string' ? JSON.parse(source) : source, 'root')
  for (const removed of ['trust', 'capabilities', 'contributes', 'signature', 'entry']) {
    if (Object.hasOwn(manifest, removed)) {
      throw new Error(`pylon-plugin.json 字段 ${removed} 已从 API 1.0 删除`)
    }
  }
  if (manifest.schema !== 1) throw new Error('pylon-plugin.json schema 必须为 1')
  if (typeof manifest.id !== 'string' || !ID_PATTERN.test(manifest.id)) {
    throw new Error('pylon-plugin.json id 必须是点分小写命名')
  }
  if (typeof manifest.name !== 'string' || !manifest.name.trim()) throw new Error('pylon-plugin.json 缺少 name')
  if (typeof manifest.version !== 'string' || !manifest.version.trim()) throw new Error('pylon-plugin.json 缺少 version')
  if (manifest.api !== PYLON_PLUGIN_API_VERSION) {
    throw new Error(`pylon-plugin.json api 必须为 ${PYLON_PLUGIN_API_VERSION}`)
  }
  if (typeof manifest.kind !== 'string' || !KINDS.has(manifest.kind)) throw new Error('pylon-plugin.json kind 无效')
  const web = record(manifest.web, 'web')
  if (typeof web.entry !== 'string' || !web.entry.trim()) throw new Error('pylon-plugin.json 缺少 web.entry')
  if (web.styles !== undefined && (!Array.isArray(web.styles) || web.styles.some(value => typeof value !== 'string'))) {
    throw new Error('pylon-plugin.json web.styles 必须是字符串数组')
  }
  if (manifest.dependencies !== undefined) stringMap(manifest.dependencies, 'dependencies')
  if (manifest.optionalDependencies !== undefined) stringMap(manifest.optionalDependencies, 'optionalDependencies')
  if (manifest.conflicts !== undefined
    && (!Array.isArray(manifest.conflicts) || manifest.conflicts.some(value => typeof value !== 'string'))) {
    throw new Error('pylon-plugin.json conflicts 必须是字符串数组')
  }
  if (manifest.hotSwap !== undefined) {
    const hotSwap = record(manifest.hotSwap, 'hotSwap')
    if (!HOT_SWAP_MODES.has(hotSwap.mode as HotSwapMode)) throw new Error('pylon-plugin.json hotSwap.mode 无效')
    if (hotSwap.drainTimeoutMs !== undefined
      && (!Number.isFinite(hotSwap.drainTimeoutMs) || Number(hotSwap.drainTimeoutMs) <= 0)) {
      throw new Error('pylon-plugin.json hotSwap.drainTimeoutMs 必须是正数')
    }
  }
  if (manifest.reactVersion !== undefined && typeof manifest.reactVersion !== 'string') {
    throw new Error('pylon-plugin.json reactVersion 必须是字符串')
  }
  return manifest as unknown as PylonPluginManifest
}
