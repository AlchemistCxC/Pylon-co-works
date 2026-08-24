/**
 * C16 三 provider 全覆盖审计 — 机器可读 inventory（DIC-C16-01）。
 *
 * 数据来源：`Docs/渲染引擎施工/02-三方工具与事件归一化字典.md` §二–§七的 121 个映射单元
 * （claude-code 44 / peri 46 / hermes 31，与字典 §十 计数一致）。
 * 每项状态只允许四种（卡定义，禁止"可能不会发送"式含糊）：
 * - `normalized`            wire 到达 + normalizer 分支 + projector slice + renderer/fallback + fixture 全链齐备；
 * - `flattened-with-reason` wire 已不可逆扁平化（如 Hermes cancelled todo → completed 文本），保留 raw + 低置信诊断；
 * - `not-transported`       源码证明当前 bridge 不发送（关联 ACP-UP 上游补发任务）；
 * - `unknown-fallback`      进 unknown/raw 且有可见通用 fallback。
 *
 * 架构判定两列：
 * - `firstClassFields` 已进入 normalized/projector/runtime selector 的结构化字段（renderer 可直接消费）；
 * - `retainedOnlyFields` 仅存在于 event/raw/metadata 的可审计字段——不得统计为「已消费」。
 */

export type CoverageStatus =
  | 'normalized'
  | 'flattened-with-reason'
  | 'not-transported'
  | 'unknown-fallback'

export type ProviderName = 'claude-code' | 'peri' | 'hermes'

export type TransportStatus =
  | 'WIRE-STANDARD'
  | 'WIRE-EXTENSION'
  | 'SYNTHETIC'
  | 'SOURCE-ONLY/BACKLOG'

export interface VerifiedCoverageEvidence {
  readonly state: 'verified'
  readonly refs: readonly string[]
  readonly note: string
}

export interface UnavailableCoverageEvidence {
  readonly state: 'unavailable'
  readonly reason: string
}

export interface NotApplicableCoverageEvidence {
  readonly state: 'not-applicable'
  readonly reason: string
}

export type CoverageEvidenceClaim =
  | VerifiedCoverageEvidence
  | UnavailableCoverageEvidence
  | NotApplicableCoverageEvidence

export interface CoverageEvidence {
  readonly source: VerifiedCoverageEvidence
  readonly wireFixture: CoverageEvidenceClaim
  readonly identity: CoverageEvidenceClaim
  readonly provenance: CoverageEvidenceClaim
  readonly normalizer: CoverageEvidenceClaim
  readonly projector: CoverageEvidenceClaim
  readonly solidRenderer: CoverageEvidenceClaim
  readonly reactFallback: CoverageEvidenceClaim
  readonly settingsSchema: CoverageEvidenceClaim
  readonly pluginLifecycle: CoverageEvidenceClaim
  readonly tests: CoverageEvidenceClaim
}

export interface CoverageItem {
  readonly id: string
  readonly provider: ProviderName
  /** 字典 §二–§七 行号锚点 */
  readonly dictionarySection: string
  /** 字典「原始操作/事件」列摘要（wire discriminator 或 SDK symbol） */
  readonly wireSymbol: string
  /** 归一化后事件 kind（event.type）；SOURCE-ONLY 项为空串 */
  readonly semanticEvent: string
  /** renderer semanticKind；未注册为渲染 kind 时为空串 */
  readonly renderKind: string
  readonly status: CoverageStatus
  /** 字典 D02 transport gate；SOURCE-ONLY 绝不能伪装成已到达 wire 的 unknown。 */
  readonly transportStatus: TransportStatus
  /** C16 卡要求的逐项 source→wire→projection→双 fallback→settings/cleanup/test 证据。 */
  readonly evidence: CoverageEvidence
  /** first-class：已进入 projector/runtime selector 的结构化字段 */
  readonly firstClassFields: readonly string[]
  /** retained-only：仅 raw/metadata 可审计、无 selector/renderer contract 的字段 */
  readonly retainedOnlyFields: readonly string[]
  /** Pylon 消费证据：normalizer/projector/renderer 文件锚点 */
  readonly pylonAnchors: readonly string[]
  /** fixture 测试文件 */
  readonly fixtures: readonly string[]
  /** not-transported/flattened 必填：上游任务编号或扁平化原因 */
  readonly followUp: string
}

/** Provider inventory 源行；transport status 在统一 gate 中按覆盖结论收敛。 */
export type CoverageItemDraft = Omit<CoverageItem, 'transportStatus' | 'evidence'>

export interface ProviderCoverageSummary {
  readonly provider: ProviderName
  readonly totalUnits: number
  readonly byStatus: Readonly<Record<CoverageStatus, number>>
}
