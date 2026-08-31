/**
 * skinSchema — 从实际主题字段真值动态派生 SkinSchema（阶段 5 S5-A）。
 *
 * 字段来源：`THEME_FIELD_DEFS`（唯一字段元数据真值）。
 * componentVariants 来源：
 * - `input-bar` / `control-center`：直接取 `THEME_FIELD_DEFS` 中
 *   `inputVariant` / `ccStyle` 的 options（避免第二张枚举表）；
 * - `message`：来自 `components/chat/messageTypes.ts` 的 `MESSAGE_ROLES`；
 * - `tool-call`：来自 `domains/tool/status.ts` 的 `TOOL_VISUAL_STATES`。
 * surfaces：当前源码尚无 `data-pylon-surface` 真值；本阶段先输出最小稳定集合，
 * 来源为 App 实际布局结构（App root / SheetLayout 三段式 / App 级 dialog），
 * S5-C 会把这些值落到真实 DOM。
 */
import { THEME_FIELD_DEFS, THEME_SETTING_KEYS, fieldToCssVar, type ThemeFieldDef, type ThemeFieldKey } from '../../themeFieldDefs.ts'
import { DEFAULTS } from '../../domains/theme/themeDefaults.ts'
import { MESSAGE_ROLES } from '../../components/chat/messageTypes.ts'
import { TOOL_VISUAL_STATES } from '../../domains/tool/status.ts'
import type {
  SkinFieldSchema,
  SkinFieldType,
  SkinSchema,
} from './skinTypes.ts'

/**
 * 最小稳定 surface 集合（S5-C 落地 data-pylon-surface）：
 * - app：App 根容器（.app，Kernel/Application 边界内）
 * - workspace：SheetLayout 工作区容器（.layout）
 * - sidebar：SheetSidebarSlot 容器
 * - main：SheetHost 活动 sheet 主区容器
 * - right：应用级 RightRailHost 容器
 * - dialog：App 级对话框容器（Settings/Profile/Session 等，保留边界）
 */
export const SKIN_SURFACES = Object.freeze([
  'app',
  'workspace',
  'sidebar',
  'main',
  'right',
  'dialog',
] as const)

export type SkinSurface = (typeof SKIN_SURFACES)[number]

const FIELD_TYPES: ReadonlySet<string> = new Set(['color', 'number', 'select', 'boolean', 'text'])

function assertFieldType(type: string): asserts type is SkinFieldType {
  if (!FIELD_TYPES.has(type)) throw new Error(`未知 Skin 字段类型：${type}`)
}

function resolveCssVar(key: ThemeFieldKey, def: ThemeFieldDef): string | undefined {
  if (def.noCssVar) return undefined
  if (def.cssVar) return def.cssVar
  if (def.type === 'color' || def.type === 'number') return fieldToCssVar(key)
  return undefined
}

function cloneDefault(value: unknown): unknown {
  if (value === undefined) return undefined
  if (typeof value === 'object' && value !== null) return structuredClone(value)
  return value
}

function buildFields(): Record<string, SkinFieldSchema> {
  const fields: Record<string, SkinFieldSchema> = {}
  for (const key of THEME_SETTING_KEYS) {
    const def = THEME_FIELD_DEFS[key] as ThemeFieldDef
    assertFieldType(def.type)
    const field: SkinFieldSchema = {
      type: def.type,
      label: def.label,
      zone: def.zone,
    }
    if (def.min !== undefined) field.min = def.min
    if (def.max !== undefined) field.max = def.max
    if (def.step !== undefined) field.step = def.step
    if (def.options) field.options = [...def.options]
    const cssVar = resolveCssVar(key, def)
    if (cssVar) field.cssVar = cssVar
    const defaultValue = def.default !== undefined
      ? cloneDefault(def.default)
      : cloneDefault(DEFAULTS[key])
    if (defaultValue !== undefined) field.default = defaultValue
    fields[key] = field
  }
  return fields
}

function buildComponentVariants(): Record<string, string[]> {
  const inputBarOptions = THEME_FIELD_DEFS.inputVariant.options ?? []
  const controlCenterOptions = THEME_FIELD_DEFS.ccStyle.options ?? []
  return {
    'input-bar': [...inputBarOptions],
    'control-center': [...controlCenterOptions],
    'message': [...MESSAGE_ROLES],
    'tool-call': [...TOOL_VISUAL_STATES],
  }
}

/** FNV-1a 32-bit，把 schema 形状压成稳定短 id（同输入同输出） */
function fnv1a(input: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(36)
}

function sortRecord<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(
    Object.keys(record).sort().map(key => [key, record[key]]),
  ) as Record<string, T>
}

function schemaShape(): Omit<SkinSchema, 'revision'> {
  return {
    fields: sortRecord(buildFields()),
    componentVariants: sortRecord(buildComponentVariants()),
    surfaces: [...SKIN_SURFACES].sort(),
  }
}

export function computeSkinSchemaRevision(shape: Omit<SkinSchema, 'revision'>): string {
  return `skin-${fnv1a(JSON.stringify(shape))}`
}

/** 动态枚举当前 SkinSchema；连续调用在输入不变时深相等，revision 稳定 */
export function getSkinSchema(): SkinSchema {
  const shape = schemaShape()
  return {
    revision: computeSkinSchemaRevision(shape),
    ...shape,
  }
}
