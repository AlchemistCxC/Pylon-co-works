/**
 * skinRuntime — Skin Runtime 状态机（阶段 5 S5-B）。
 *
 * 单一真值：Draft / Preview / InstalledSkin 生命周期由本类持有。
 * Preview 不写入永久 Theme Store；commit 是唯一把皮肤写入 committed + binding 的动作。
 */
import { DEFAULTS } from '../../domains/theme/themeDefaults.ts'
import { getSkinSchema } from './skinSchema.ts'
import { resolveSkinLayers, type SkinResolutionLayer, type SkinResolveOptions } from './skinResolver.ts'
import { validateSkinDraft } from './skinValidation.ts'
import type {
  CreateSkinDraftInput,
  InstalledSkin,
  ResolvedSkin,
  SkinDraft,
  SkinPatch,
  SkinPreview,
  SkinRuntimeSnapshot,
  SkinSchema,
  SkinTarget,
  SkinValidationResult,
} from './skinTypes.ts'

export interface SkinResolutionContext {
  workspaceId?: string
  agentId?: string
  sessionId?: string
}

export interface SkinRollbackResult {
  status: 'rolled-back' | 'not-found' | 'already-settled'
  previewId: string
  previousStatus?: SkinPreview['status']
}

export function skinTargetKey(target: SkinTarget): string {
  switch (target.scope) {
    case 'global':
      return 'global'
    case 'workspace':
      return `workspace:${target.workspaceId}`
    case 'agent':
      return `agent:${target.agentId}`
    case 'session':
      return `session:${target.sessionId}`
  }
}

export function parseSkinTargetKey(key: string): SkinTarget | null {
  if (key === 'global') return { scope: 'global' }
  const separator = key.indexOf(':')
  if (separator < 0) return null
  const scope = key.slice(0, separator)
  const id = key.slice(separator + 1)
  if (!id) return null
  if (scope === 'workspace') return { scope: 'workspace', workspaceId: id }
  if (scope === 'agent') return { scope: 'agent', agentId: id }
  if (scope === 'session') return { scope: 'session', sessionId: id }
  return null
}

function cloneRecord<T>(value: Record<string, T>): Record<string, T> {
  return structuredClone(value)
}

export class SkinRuntime {
  private readonly schema: SkinSchema = getSkinSchema()
  private readonly drafts = new Map<string, SkinDraft>()
  private readonly previews = new Map<string, SkinPreview>()
  private readonly previewByTarget = new Map<string, string>()
  private readonly committed = new Map<string, InstalledSkin>()
  private readonly bindings = new Map<string, string>()
  private readonly listeners = new Set<() => void>()
  private globalBaseline: Record<string, unknown> = DEFAULTS as unknown as Record<string, unknown>
  private draftSequence = 0
  private previewSequence = 0
  private revision = 0
  private snapshot: SkinRuntimeSnapshot = Object.freeze({
    revision: 0,
    activePreview: null,
    committedSkinCount: 0,
    bindings: Object.freeze({}),
  })

  schemaSnapshot(): SkinSchema {
    return this.schema
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      this.listeners.delete(listener)
    }
  }

  getSnapshot(): SkinRuntimeSnapshot {
    return this.snapshot
  }

  getDraft(draftId: string): SkinDraft | undefined {
    return this.drafts.get(draftId)
  }

  listDrafts(): SkinDraft[] {
    return [...this.drafts.values()].sort((a, b) => a.draftId.localeCompare(b.draftId))
  }

  restoreDraft(draft: SkinDraft): void {
    const restored: SkinDraft = {
      ...draft,
      tokens: cloneRecord(draft.tokens),
      variants: cloneRecord(draft.variants),
      assets: cloneRecord(draft.assets),
    }
    this.drafts.set(restored.draftId, restored)
    const sequence = Number(restored.draftId.replace(/^draft-/, ''))
    if (Number.isFinite(sequence) && sequence > this.draftSequence) this.draftSequence = sequence
    this.publish()
  }

  getBindingsSnapshot(): Record<string, string> {
    return Object.fromEntries(this.bindings)
  }

  listInstalledSkins(): InstalledSkin[] {
    return [...this.committed.values()].sort((a, b) => a.createdAt - b.createdAt)
  }

  getInstalledSkin(skinId: string): InstalledSkin | undefined {
    return this.committed.get(skinId)
  }

  createDraft(input: CreateSkinDraftInput): SkinDraft {
    const name = input.name.trim()
    if (!name) throw new Error('Skin 名称不能为空')

    const draft: SkinDraft = {
      draftId: `draft-${++this.draftSequence}`,
      name: name.slice(0, 40),
      ...(input.baseSkinId ? { baseSkinId: input.baseSkinId } : {}),
      tokens: cloneRecord(input.tokens ?? {}),
      variants: cloneRecord(input.variants ?? {}),
      ...(input.css !== undefined ? { css: input.css } : {}),
      assets: {},
      revision: 1,
      status: 'editing',
    }
    this.drafts.set(draft.draftId, draft)
    this.publish()
    return draft
  }

  patchDraft(draftId: string, patch: SkinPatch): SkinDraft {
    const draft = this.mustGetDraft(draftId)
    if (draft.status === 'committed') throw new Error(`已提交的 draft 不可再 patch：${draftId}`)

    const nextTokens = { ...draft.tokens }
    for (const [key, value] of Object.entries(patch.tokens ?? {})) {
      if (value !== undefined) nextTokens[key] = value
    }
    const nextVariants = { ...draft.variants }
    for (const [key, value] of Object.entries(patch.variants ?? {})) {
      if (value !== undefined) nextVariants[key] = value
    }

    draft.tokens = nextTokens
    draft.variants = nextVariants
    if (patch.css !== undefined) draft.css = patch.css
    draft.revision += 1
    draft.status = 'editing'

    this.refreshPreviewsForDraft(draftId)
    this.publish()
    return draft
  }

  validate(draftId: string): SkinValidationResult {
    const draft = this.mustGetDraft(draftId)
    const result = validateSkinDraft(draft, this.schema)
    draft.status = result.valid ? 'valid' : 'invalid'
    this.publish()
    return result
  }

  preview(draftId: string, target: SkinTarget): SkinPreview {
    const draft = this.mustGetDraft(draftId)
    const validation = validateSkinDraft(draft, this.schema)
    if (!validation.valid) {
      draft.status = 'invalid'
      this.publish()
      throw new Error(`Skin draft 校验失败：${validation.issues[0]?.message ?? '未知错误'}`)
    }
    draft.status = 'valid'

    const targetKey = skinTargetKey(target)
    const existingPreviewId = this.previewByTarget.get(targetKey)
    if (existingPreviewId) this.rollback(existingPreviewId)

    const before = this.resolveSkin(target)
    const previewId = `preview-${++this.previewSequence}`
    const preview: SkinPreview = {
      previewId,
      draftId,
      target,
      before,
      resolved: before,
      createdAt: Date.now(),
      status: 'active',
    }
    this.previews.set(previewId, preview)
    this.previewByTarget.set(targetKey, previewId)
    preview.resolved = this.resolveSkin(target)
    this.publish()
    return preview
  }

  patchPreview(previewId: string, patch: SkinPatch): SkinPreview {
    const preview = this.previews.get(previewId)
    if (!preview) throw new Error(`preview 不存在：${previewId}`)
    if (preview.status !== 'active') throw new Error(`preview 状态不允许 patch：${preview.status}`)

    this.patchDraft(preview.draftId, patch)
    const refreshed = this.previews.get(previewId)
    if (!refreshed) throw new Error(`preview 不存在：${previewId}`)
    return refreshed
  }

  rollback(previewId: string): SkinRollbackResult {
    const preview = this.previews.get(previewId)
    if (!preview) return { status: 'not-found', previewId }

    if (preview.status !== 'active') {
      return { status: 'already-settled', previewId, previousStatus: preview.status }
    }

    preview.status = 'rolled-back'
    const targetKey = skinTargetKey(preview.target)
    if (this.previewByTarget.get(targetKey) === previewId) this.previewByTarget.delete(targetKey)
    this.publish()
    return { status: 'rolled-back', previewId }
  }

  commit(previewId: string): InstalledSkin {
    const preview = this.previews.get(previewId)
    if (!preview) throw new Error(`preview 不存在：${previewId}`)

    const draft = this.mustGetDraft(preview.draftId)
    const skinId = `skin-${draft.draftId}`

    if (preview.status === 'committed') {
      const existing = this.committed.get(skinId)
      if (existing) return existing
    }
    if (preview.status !== 'active') throw new Error(`preview 状态不允许 commit：${preview.status}`)

    const now = Date.now()
    const installed: InstalledSkin = {
      skinId,
      name: draft.name,
      tokens: cloneRecord(preview.resolved.tokens),
      variants: cloneRecord(preview.resolved.variants),
      ...(preview.resolved.css !== undefined ? { css: preview.resolved.css } : {}),
      assets: cloneRecord(draft.assets),
      createdAt: now,
      updatedAt: now,
    }
    this.committed.set(skinId, installed)
    this.bindings.set(skinTargetKey(preview.target), skinId)
    preview.status = 'committed'
    const targetKey = skinTargetKey(preview.target)
    if (this.previewByTarget.get(targetKey) === previewId) this.previewByTarget.delete(targetKey)
    draft.status = 'committed'
    this.publish()
    return installed
  }

  resolveSkin(
    target: SkinTarget,
    context: SkinResolutionContext = {},
    options: SkinResolveOptions = {},
  ): ResolvedSkin {
    const effective = { ...context }
    if (target.scope === 'workspace') effective.workspaceId = target.workspaceId
    if (target.scope === 'agent') effective.agentId = target.agentId
    if (target.scope === 'session') effective.sessionId = target.sessionId

    const layers: SkinResolutionLayer[] = [
      {
        kind: 'default',
        tokens: DEFAULTS as unknown as Record<string, unknown>,
      },
      {
        kind: 'default',
        tokens: this.globalBaseline,
      },
    ]
    this.appendScopeLayers(layers, 'global')
    if (effective.workspaceId) this.appendScopeLayers(layers, 'workspace', effective.workspaceId)
    if (effective.agentId) this.appendScopeLayers(layers, 'agent', effective.agentId)
    if (effective.sessionId) this.appendScopeLayers(layers, 'session', effective.sessionId)

    const resolved = resolveSkinLayers(layers, options)
    resolved.revision = this.revision
    return resolved
  }

  inspect(target: SkinTarget, context?: SkinResolutionContext): ResolvedSkin {
    return this.resolveSkin(target, context)
  }

  /** 供持久化恢复使用：直接安装已提交皮肤（不触发 commit 语义） */
  restoreInstalledSkin(installed: InstalledSkin): void {
    this.committed.set(installed.skinId, {
      ...installed,
      tokens: cloneRecord(installed.tokens),
      variants: cloneRecord(installed.variants),
      assets: cloneRecord(installed.assets),
    })
    this.publish()
  }

  bindSkin(skinId: string, target: SkinTarget): void {
    if (!this.committed.has(skinId)) throw new Error(`皮肤不存在：${skinId}`)
    this.bindings.set(skinTargetKey(target), skinId)
    this.publish()
  }

  unbindTarget(target: SkinTarget): void {
    this.bindings.delete(skinTargetKey(target))
    this.publish()
  }

  getBindingSkinId(target: SkinTarget): string | undefined {
    return this.bindings.get(skinTargetKey(target))
  }

  /** Theme Store 基线输入：启用 Skin Runtime 后现有主题外观保持不变 */
  setGlobalBaseline(tokens: Record<string, unknown>): void {
    this.globalBaseline = cloneRecord(tokens)
    this.publish()
  }

  private appendScopeLayers(
    layers: SkinResolutionLayer[],
    scope: SkinTarget['scope'],
    id?: string,
  ): void {
    const target: SkinTarget = scope === 'global'
      ? { scope: 'global' }
      : scope === 'workspace'
        ? { scope: 'workspace', workspaceId: id! }
        : scope === 'agent'
          ? { scope: 'agent', agentId: id! }
          : { scope: 'session', sessionId: id! }
    const targetKey = skinTargetKey(target)

    const bindingSkinId = this.bindings.get(targetKey)
    if (bindingSkinId) {
      const skin = this.committed.get(bindingSkinId)
      if (skin) {
        layers.push({
          kind: 'committed',
          target,
          skinId: skin.skinId,
          tokens: skin.tokens,
          variants: skin.variants,
          ...(skin.css !== undefined ? { css: skin.css } : {}),
        })
      }
    }

    const previewId = this.previewByTarget.get(targetKey)
    if (previewId) {
      const preview = this.previews.get(previewId)
      const draft = preview ? this.drafts.get(preview.draftId) : undefined
      if (preview && draft && preview.status === 'active') {
        layers.push({
          kind: 'preview',
          target,
          previewId: preview.previewId,
          tokens: this.previewLayerTokens(draft),
          variants: draft.variants,
          ...(draft.css !== undefined ? { css: draft.css } : {}),
        })
      }
    }
  }

  private previewLayerTokens(draft: SkinDraft): Record<string, unknown> {
    if (!draft.baseSkinId) return draft.tokens
    const base = this.committed.get(draft.baseSkinId)
    if (!base) return draft.tokens
    return { ...base.tokens, ...draft.tokens }
  }

  private refreshPreviewsForDraft(draftId: string): void {
    for (const preview of this.previews.values()) {
      if (preview.draftId !== draftId || preview.status !== 'active') continue
      preview.resolved = this.resolveSkin(preview.target)
    }
  }

  private mustGetDraft(draftId: string): SkinDraft {
    const draft = this.drafts.get(draftId)
    if (!draft) throw new Error(`draft 不存在：${draftId}`)
    return draft
  }

  private publish(): void {
    this.revision += 1
    const activePreviews = [...this.previews.values()]
      .filter(preview => preview.status === 'active')
      .sort((a, b) => a.createdAt - b.createdAt)
    this.snapshot = Object.freeze({
      revision: this.revision,
      activePreview: activePreviews.at(-1) ?? null,
      committedSkinCount: this.committed.size,
      bindings: Object.freeze(Object.fromEntries(this.bindings)),
    })
    for (const listener of [...this.listeners]) listener()
  }
}
