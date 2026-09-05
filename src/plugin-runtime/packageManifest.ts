import type { BuiltinPluginDefinition } from './pluginRuntime.ts'
import type { HotSwapMode } from './shadowUpdate.ts'

export const PYLON_PLUGIN_API_MIN = '1.0' as const
export const PYLON_PLUGIN_API_LATEST = '1.2' as const
/** 宿主接受的全部 API 小版本（allowlist）：minor 只做加法且向后兼容，
 *  1.0 插件在 1.1/1.2 宿主继续激活；未知更高版本拒绝并提示升级宿主。 */
export const PYLON_PLUGIN_API_SUPPORTED = [PYLON_PLUGIN_API_MIN, '1.1' as const, PYLON_PLUGIN_API_LATEST] as const
export type PylonPluginApiVersion = (typeof PYLON_PLUGIN_API_SUPPORTED)[number]
/** @deprecated 语义是宿主接受的最低版本，改用 PYLON_PLUGIN_API_MIN */
export const PYLON_PLUGIN_API_VERSION = PYLON_PLUGIN_API_MIN
export const PYLON_PLUGIN_MANIFEST_FILE = 'pylon-plugin.json' as const

/** API 1.2 capability 封闭词表（只增不改）：manifest 可声明的宿主能力。 */
export const PYLON_PLUGIN_CAPABILITIES = ['plugin.management'] as const
export type PylonPluginCapability = (typeof PYLON_PLUGIN_CAPABILITIES)[number]

export class PluginManifestError extends Error {
  readonly code = 'plugin_manifest_invalid'

  constructor(
    readonly field: string,
    message: string,
  ) {
    super(`pylon-plugin.json ${field} ${message}`)
    this.name = 'PluginManifestError'
  }
}

export interface PylonPluginManifest {
  readonly schema: 1
  readonly id: string
  readonly name: string
  readonly version: string
  readonly api: PylonPluginApiVersion
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
  /** API 1.2 新增：声明所需的宿主能力（封闭词表，见 PYLON_PLUGIN_CAPABILITIES）；
   *  1.0/1.1 manifest 出现该字段仍按 removed-field 拒绝。 */
  readonly capabilities?: readonly string[]
}

const ID_PATTERN = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/
const VERSION_RANGE_PATTERN = /^(?:\*|\^?\d+\.\d+\.\d+)$/
const KINDS = new Set([
  'shell', 'workspace', 'feature', 'hook', 'renderer', 'skin', 'agent-adapter',
  'tool-provider', 'service', 'automation',
])
const HOT_SWAP_MODES = new Set<HotSwapMode>([
  'parallel', 'exclusive', 'soft-remount', 'restart-required',
])
const API_SUPPORTED_SET = new Set<string>(PYLON_PLUGIN_API_SUPPORTED)
const CAPABILITY_SET = new Set<string>(PYLON_PLUGIN_CAPABILITIES)

/** capabilities 自 API 1.2 起为合法字段；1.0/1.1 出现即按 removed-field 拒绝。 */
function removedFieldsFor(api: unknown): readonly string[] {
  return api === PYLON_PLUGIN_API_LATEST
    ? ['trust', 'contributes', 'signature', 'entry']
    : ['trust', 'capabilities', 'contributes', 'signature', 'entry']
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`pylon-plugin.json ${field} 必须是对象`)
  }
  return value as Record<string, unknown>
}

function stringMap(value: unknown, field: string): void {
  const map = record(value, field)
  for (const [key, entry] of Object.entries(map)) {
    if (!ID_PATTERN.test(key)) {
      throw new PluginManifestError(`${field}.${key}`, '依赖 id 必须是点分小写命名')
    }
    if (typeof entry !== 'string') throw new Error(`pylon-plugin.json ${field}.${key} 必须是字符串`)
    if (!VERSION_RANGE_PATTERN.test(entry)) {
      throw new PluginManifestError(
        `${field}.${key}`,
        '只支持 exact、caret 或 * 版本范围',
      )
    }
  }
}

export function parsePylonPluginManifest(source: string | unknown): PylonPluginManifest {
  const manifest = record(typeof source === 'string' ? JSON.parse(source) : source, 'root')
  for (const removed of removedFieldsFor(manifest.api)) {
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
  if (typeof manifest.api !== 'string' || !API_SUPPORTED_SET.has(manifest.api)) {
    throw new Error(
      `pylon-plugin.json api 仅支持 ${PYLON_PLUGIN_API_SUPPORTED.join('/')}（更高版本需升级宿主）`,
    )
  }
  if (manifest.api === PYLON_PLUGIN_API_LATEST && manifest.capabilities !== undefined) {
    if (!Array.isArray(manifest.capabilities)
      || manifest.capabilities.some(value => typeof value !== 'string' || !value.trim())) {
      throw new PluginManifestError('capabilities', '必须是字符串数组')
    }
    const seen = new Set<string>()
    manifest.capabilities.forEach((capability, index) => {
      if (!CAPABILITY_SET.has(capability)) {
        throw new PluginManifestError(
          `capabilities.${index}`,
          `未知 capability（封闭词表：${PYLON_PLUGIN_CAPABILITIES.join('/')}）`,
        )
      }
      if (seen.has(capability)) {
        throw new PluginManifestError(`capabilities.${index}`, 'capability 重复声明')
      }
      seen.add(capability)
    })
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
  if (Array.isArray(manifest.conflicts)) {
    manifest.conflicts.forEach((conflict, index) => {
      if (typeof conflict !== 'string' || !ID_PATTERN.test(conflict)) {
        throw new PluginManifestError(`conflicts.${index}`, '必须是合法插件 id')
      }
      if (conflict === manifest.id) {
        throw new PluginManifestError(`conflicts.${index}`, '不能与插件自身冲突')
      }
    })
  }
  if (manifest.activation !== undefined) {
    const activation = record(manifest.activation, 'activation')
    const events = activation.events
    if (!Array.isArray(events)
      || events.length === 0
      || events.some(event => typeof event !== 'string' || !event.trim())
      || new Set(events).size !== events.length) {
      throw new PluginManifestError(
        'activation.events',
        '必须是非空且不重复的字符串数组',
      )
    }
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
