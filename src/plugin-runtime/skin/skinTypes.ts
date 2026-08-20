/**
 * skinTypes — Skin Runtime 的纯数据 contract（阶段 5）。
 *
 * 设计约束：
 * - 只放可序列化数据，禁止函数/Store/DOM/React 对象进入 contract；
 * - Agent/Command 只能通过 Skin Runtime API 操作皮肤，不直接改 Store 或 DOM；
 * - 这里的类型是 Skin 域对外 contract，与 themeFieldDefs 的 ThemeSettings 解耦。
 */

export type SkinTarget =
  | { scope: 'global' }
  | { scope: 'workspace'; workspaceId: string }
  | { scope: 'agent'; agentId: string }
  | { scope: 'session'; sessionId: string }

export type SkinFieldType = 'color' | 'number' | 'select' | 'boolean' | 'text'

export interface SkinFieldSchema {
  type: SkinFieldType
  label: string
  zone: string
  min?: number
  max?: number
  step?: number
  options?: string[]
  /** CSS 变量注入名；noCssVar 或非 color/number 字段为 undefined */
  cssVar?: string
  default?: unknown
}

export interface SkinSchema {
  /** 由 schema 形状稳定派生（同输入同 revision，不用时间戳） */
  revision: string
  fields: Record<string, SkinFieldSchema>
  /** 稳定组件 id → 允许的 variant 值；来自实际组件实现，不硬编码 */
  componentVariants: Record<string, string[]>
  surfaces: string[]
}

export interface SkinAssetRef {
  id: string
  path?: string
  mime?: string
  size?: number
  /** 后续资源协议阶段的引用；阶段 5 不接受实际二进制 */
  ref?: string
}

export type SkinDraftStatus = 'editing' | 'valid' | 'invalid' | 'committed'

export interface SkinDraft {
  draftId: string
  name: string
  baseSkinId?: string
  tokens: Record<string, unknown>
  variants: Record<string, string>
  css?: string
  assets: Record<string, SkinAssetRef>
  revision: number
  status: SkinDraftStatus
}

export type SkinPatch = {
  tokens?: Record<string, unknown>
  variants?: Record<string, string>
  css?: string
  assets?: Record<string, SkinAssetRef>
}

export interface CreateSkinDraftInput {
  name: string
  baseSkinId?: string
  tokens?: Record<string, unknown>
  variants?: Record<string, string>
  css?: string
}

export interface SkinValidationIssue {
  path: string
  code:
    | 'unknown-token'
    | 'invalid-type'
    | 'number-out-of-range'
    | 'invalid-option'
    | 'invalid-css'
    | 'css-too-long'
    | 'css-root-selector'
  message: string
  expected?: unknown
  actual?: unknown
}

export interface SkinValidationResult {
  valid: boolean
  issues: SkinValidationIssue[]
}

export interface SkinSourceEntry {
  /** 优先级来源：preview overlay 或 committed baseline 或 default */
  kind: 'preview' | 'committed' | 'default'
  target?: SkinTarget
  skinId?: string
  previewId?: string
  /** 该来源实际贡献的字段 key（用于可观察来源链） */
  fields: string[]
}

export interface ResolvedSkin {
  /** SkinRuntime revision（单调递增，非 schema revision） */
  revision: number
  tokens: Record<string, unknown>
  variants: Record<string, string>
  css?: string
  cssVariables: Record<string, string>
  dataAttributes: Record<string, string>
  sources: SkinSourceEntry[]
}

export type SkinPreviewStatus = 'active' | 'rolled-back' | 'committed' | 'expired'

export interface SkinPreview {
  previewId: string
  draftId: string
  target: SkinTarget
  /** preview 生效前的 resolved skin（rollback 目标） */
  before: ResolvedSkin
  /** preview 生效后的 resolved skin */
  resolved: ResolvedSkin
  createdAt: number
  status: SkinPreviewStatus
}

export interface InstalledSkin {
  skinId: string
  name: string
  tokens: Record<string, unknown>
  variants: Record<string, string>
  css?: string
  assets: Record<string, SkinAssetRef>
  createdAt: number
  updatedAt: number
}

export interface ComputedSkinInspection {
  supported: boolean
  previewId?: string
  target?: SkinTarget
  computedStyle?: Record<string, string>
  dataAttributes?: Record<string, string>
  error?: string
}

export type CaptureStatus = 'captured' | 'unsupported' | 'error'

export interface CaptureResult {
  supported: boolean
  status: CaptureStatus
  previewId?: string
  artifactRef?: string
  mime?: string
  error?: string
}

export interface CaptureOptions {
  format?: 'png' | 'webp'
  /** CLI-selected native output path; omitted uses the platform temp directory. */
  artifactPath?: string
}

export interface SkinRuntimeSnapshot {
  revision: number
  activePreview: SkinPreview | null
  committedSkinCount: number
  bindings: Record<string, string | undefined>
}
