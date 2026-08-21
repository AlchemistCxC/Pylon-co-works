import type { JsonValue } from '../content/contentPartSchema.ts'
import type {
  WorkbenchEventEnvelope,
  WorkbenchEventProvenance,
} from '../events/workbenchEventSchema.ts'
import { normalizeAcpEvent, acpNormalizer } from './acpNormalizer.ts'
import { normalizeClaudeCodeEvent, claudeCodeNormalizer } from './claudeCodeNormalizer.ts'
import { normalizeHermesEvent, hermesNormalizer } from './hermesNormalizer.ts'
import { normalizePeriEvent, periNormalizer } from './periNormalizer.ts'
import { isPylonExtension, normalizePylonExtension } from './extensionNormalizer.ts'

export interface AgentWireEnvelope {
  readonly provider?: string
  readonly source?: string
  readonly sessionId?: string
  readonly update?: unknown
  readonly params?: unknown
  readonly [key: string]: unknown
}

export interface NormalizeContext {
  readonly provider: string
  readonly sessionId: string
  readonly sourceId: string
  readonly sequence: number
  readonly recordedAt: string
  readonly occurredAt?: string
  readonly agentId?: string
  readonly parentAgentId?: string
  readonly replay?: boolean
  readonly groupedReplay?: boolean
  readonly observe?: boolean
  readonly provenance: WorkbenchEventProvenance
  readonly seenEventKeys?: Set<string>
  /** 工具语义解析使用的 registry generation；缺省读取当前 generation。 */
  readonly toolGeneration?: number
  /** Capability-negotiated extensions on this ACP connection. */
  readonly negotiatedExtensions?: readonly string[]
}

export interface NormalizeDiagnostic {
  readonly provider: string
  readonly sessionId: string
  readonly wireKind: string
  readonly path: readonly (string | number)[]
  readonly code: string
  readonly message: string
  readonly recoverable: boolean
  readonly details?: JsonValue
}

export interface NormalizeResult {
  readonly events: readonly WorkbenchEventEnvelope[]
  readonly diagnostics: readonly NormalizeDiagnostic[]
}

export interface AgentEventNormalizer {
  readonly id: string
  canNormalize(input: AgentWireEnvelope, context: NormalizeContext): boolean
  normalize(input: AgentWireEnvelope | unknown, context: NormalizeContext): NormalizeResult
}

const normalizers: readonly AgentEventNormalizer[] = [
  claudeCodeNormalizer,
  hermesNormalizer,
  periNormalizer,
  acpNormalizer,
]

export function normalizeAgentEvent(input: AgentWireEnvelope | unknown, context: NormalizeContext): NormalizeResult {
  if (isPylonExtension(input)) return normalizePylonExtension(input, context)
  const adapter = normalizers.find(candidate => candidate.canNormalize(isWireEnvelope(input), context)) ?? acpNormalizer
  return adapter.normalize(input, context)
}

export function listAgentEventNormalizers(): readonly AgentEventNormalizer[] {
  return normalizers
}

function isWireEnvelope(value: unknown): AgentWireEnvelope {
  return value && typeof value === 'object' ? value as AgentWireEnvelope : {}
}

export { normalizeAcpEvent, normalizeClaudeCodeEvent, normalizeHermesEvent, normalizePeriEvent }
export type { WorkbenchEventEnvelope }
