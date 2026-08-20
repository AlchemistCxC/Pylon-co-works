/**
 * skinPersistence — committed skins / bindings / drafts 的前端持久化（阶段 5 S5-F）。
 *
 * 独立 versioned storage key（pylon-skins），不混入 pylon-theme ThemeSettings。
 * Preview 不持久化为 active binding；恢复时先按当前 schema 清洗，非法数据丢弃并返回诊断错误。
 */
import {
  isValidSkinCss,
  isValidSkinToken,
  isValidSkinVariant,
} from '../../plugin-runtime/skin/skinValidation.ts'
import {
  parseSkinTargetKey,
  type SkinRuntime,
} from '../../plugin-runtime/skin/skinRuntime.ts'
import type {
  InstalledSkin,
  SkinDraft,
  SkinSchema,
} from '../../plugin-runtime/skin/skinTypes.ts'

export const SKIN_STORAGE_KEY = 'pylon-skins'
export const SKIN_STORAGE_VERSION = 1

export interface PersistedSkinState {
  version: number
  schemaRevision: string
  skins: InstalledSkin[]
  bindings: Record<string, string>
  drafts: SkinDraft[]
}

export interface SkinStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export interface SkinLoadResult {
  state: PersistedSkinState | null
  error?: string
}

function sanitizeAssets(value: unknown): InstalledSkin['assets'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const clean: InstalledSkin['assets'] = {}
  for (const [key, asset] of Object.entries(value as Record<string, unknown>)) {
    if (asset && typeof asset === 'object' && typeof (asset as { id?: unknown }).id === 'string') {
      clean[key] = structuredClone(asset as InstalledSkin['assets'][string])
    }
  }
  return clean
}

function sanitizeTokens(
  tokens: Record<string, unknown>,
  schema: SkinSchema,
): Record<string, unknown> {
  const clean: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(tokens)) {
    if (!(key in schema.fields)) continue
    if (!isValidSkinToken(key, value, schema)) continue
    clean[key] = value
  }
  return clean
}

function sanitizeVariants(
  variants: Record<string, string>,
  schema: SkinSchema,
): Record<string, string> {
  const clean: Record<string, string> = {}
  for (const [component, value] of Object.entries(variants)) {
    if (!isValidSkinVariant(component, value, schema)) continue
    clean[component] = value
  }
  return clean
}

function sanitizeInstalledSkin(value: unknown, schema: SkinSchema): InstalledSkin | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Partial<InstalledSkin>
  if (typeof candidate.skinId !== 'string' || !candidate.skinId) return null
  if (typeof candidate.name !== 'string' || !candidate.name.trim()) return null
  if (!candidate.tokens || typeof candidate.tokens !== 'object' || Array.isArray(candidate.tokens)) return null

  const tokens = sanitizeTokens(candidate.tokens as Record<string, unknown>, schema)
  const variants = candidate.variants && typeof candidate.variants === 'object' && !Array.isArray(candidate.variants)
    ? sanitizeVariants(candidate.variants as Record<string, string>, schema)
    : {}
  const css = typeof candidate.css === 'string' && isValidSkinCss(candidate.css)
    ? candidate.css
    : undefined
  const assets = sanitizeAssets(candidate.assets)
  const createdAt = typeof candidate.createdAt === 'number' ? candidate.createdAt : 0
  const updatedAt = typeof candidate.updatedAt === 'number' ? candidate.updatedAt : createdAt

  return {
    skinId: candidate.skinId,
    name: candidate.name.trim().slice(0, 40),
    tokens,
    variants,
    ...(css !== undefined ? { css } : {}),
    assets,
    createdAt,
    updatedAt,
  }
}

function sanitizeDraft(value: unknown, schema: SkinSchema): SkinDraft | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Partial<SkinDraft>
  if (typeof candidate.draftId !== 'string' || !candidate.draftId) return null
  if (typeof candidate.name !== 'string' || !candidate.name.trim()) return null
  if (candidate.status === 'committed') return null

  const tokens = candidate.tokens && typeof candidate.tokens === 'object' && !Array.isArray(candidate.tokens)
    ? sanitizeTokens(candidate.tokens as Record<string, unknown>, schema)
    : {}
  const variants = candidate.variants && typeof candidate.variants === 'object' && !Array.isArray(candidate.variants)
    ? sanitizeVariants(candidate.variants as Record<string, string>, schema)
    : {}
  const css = typeof candidate.css === 'string' && isValidSkinCss(candidate.css)
    ? candidate.css
    : undefined
  const revision = typeof candidate.revision === 'number' && candidate.revision > 0 ? candidate.revision : 1

  return {
    draftId: candidate.draftId,
    name: candidate.name.trim().slice(0, 40),
    ...(typeof candidate.baseSkinId === 'string' && candidate.baseSkinId ? { baseSkinId: candidate.baseSkinId } : {}),
    tokens,
    variants,
    ...(css !== undefined ? { css } : {}),
    assets: {},
    revision,
    status: 'editing',
  }
}

export function serializeSkinState(
  runtime: SkinRuntime,
  schema: SkinSchema = runtime.schemaSnapshot(),
): PersistedSkinState {
  return {
    version: SKIN_STORAGE_VERSION,
    schemaRevision: schema.revision,
    skins: runtime.listInstalledSkins(),
    bindings: runtime.getBindingsSnapshot(),
    drafts: runtime.listDrafts(),
  }
}

export function persistSkinState(storage: SkinStorage, runtime: SkinRuntime): void {
  const state = serializeSkinState(runtime)
  storage.setItem(SKIN_STORAGE_KEY, JSON.stringify(state))
}

export function loadSkinState(
  storage: SkinStorage,
  schema: SkinSchema,
): SkinLoadResult {
  const raw = storage.getItem(SKIN_STORAGE_KEY)
  if (!raw) return { state: null }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    return { state: null, error: `pylon-skins JSON 解析失败：${error instanceof Error ? error.message : String(error)}` }
  }

  if (!parsed || typeof parsed !== 'object') {
    return { state: null, error: 'pylon-skins 顶层结构非法' }
  }
  const record = parsed as Record<string, unknown>
  if (record.version !== SKIN_STORAGE_VERSION) {
    return { state: null, error: `pylon-skins 版本不支持：${String(record.version)}` }
  }

  const skins = Array.isArray(record.skins)
    ? record.skins.flatMap(value => {
        const skin = sanitizeInstalledSkin(value, schema)
        return skin ? [skin] : []
      })
    : []
  const drafts = Array.isArray(record.drafts)
    ? record.drafts.flatMap(value => {
        const draft = sanitizeDraft(value, schema)
        return draft ? [draft] : []
      })
    : []
  const bindings: Record<string, string> = {}
  if (record.bindings && typeof record.bindings === 'object' && !Array.isArray(record.bindings)) {
    for (const [targetKey, skinId] of Object.entries(record.bindings as Record<string, unknown>)) {
      if (typeof skinId !== 'string' || !parseSkinTargetKey(targetKey)) continue
      if (!skins.some(skin => skin.skinId === skinId)) continue
      bindings[targetKey] = skinId
    }
  }

  const state: PersistedSkinState = {
    version: SKIN_STORAGE_VERSION,
    schemaRevision: schema.revision,
    skins,
    bindings,
    drafts,
  }
  if (typeof record.schemaRevision === 'string' && record.schemaRevision !== schema.revision) {
    return { state, error: `pylon-skins schema revision 已变化：${record.schemaRevision} → ${schema.revision}（已按当前 schema 清洗）` }
  }
  return { state }
}

export function restoreSkinState(
  runtime: SkinRuntime,
  state: PersistedSkinState,
): { restoredSkins: number; restoredBindings: number; restoredDrafts: number } {
  for (const skin of state.skins) runtime.restoreInstalledSkin(skin)
  for (const draft of state.drafts) runtime.restoreDraft(draft)

  let restoredBindings = 0
  for (const [targetKey, skinId] of Object.entries(state.bindings)) {
    const target = parseSkinTargetKey(targetKey)
    if (!target) continue
    if (!runtime.getInstalledSkin(skinId)) continue
    runtime.bindSkin(skinId, target)
    restoredBindings += 1
  }

  return {
    restoredSkins: state.skins.length,
    restoredBindings,
    restoredDrafts: state.drafts.length,
  }
}

/** 删除某 target binding 时只影响该 scope，不误删其他 scope（S5-F 契约） */
export function removeBindingForTarget(
  runtime: SkinRuntime,
  targetKey: string,
): void {
  const target = parseSkinTargetKey(targetKey)
  if (!target) return
  runtime.unbindTarget(target)
}
