export interface AgentRuntimeDetectorMetadata {
  id: string
  provider: string
  protocol: 'acp'
  priority: number
}

export interface AgentDetectionEvidence { kind: string; detail: string }
export type AgentIdentityConfidence = 'exact' | 'high' | 'medium' | 'low'
export type AgentStartability = 'not_tested' | 'verified' | 'failed'
export type AgentProtocolAvailability = 'not_tested' | 'verified' | 'failed'

export interface AgentDetectionDiagnostic {
  code: string
  stage: string
  detectorId?: string
  message: string
  retryable: boolean
}

export interface AgentRuntimeCandidate {
  candidateId: string
  detectorId: string
  provider: string
  suggestedAgentId: string
  name: string
  executable: string
  args: string[]
  evidence: AgentDetectionEvidence[]
  identityConfidence: AgentIdentityConfidence
  /** Backend emits this for every candidate; optional keeps older persisted/mock payloads readable. */
  startability?: AgentStartability
  protocolAvailability: AgentProtocolAvailability
  alreadyImportedAgentId?: string
  warnings: string[]
}

export interface AgentDetectionReport {
  candidates: AgentRuntimeCandidate[]
  diagnostics: AgentDetectionDiagnostic[]
  elapsedMs: number
  truncated: boolean
}

export const BUILTIN_AGENT_DETECTORS: readonly AgentRuntimeDetectorMetadata[] = builtinAgentCatalog.detectors()

/** Only ACP detector contributions may cross the native ACP discovery boundary. */
export function selectAcpRuntimeDetectorIds(
  detectors: readonly AgentRuntimeDetectorMetadata[],
): string[] {
  return detectors
    .filter(detector => detector.protocol === 'acp' && detector.id.trim().length > 0)
    .sort((left, right) => right.priority - left.priority || left.id.localeCompare(right.id))
    .map(detector => detector.id)
}

export function normalizeAgentRuntimeCandidates(raw: unknown): AgentRuntimeCandidate[] {
  if (!Array.isArray(raw)) return []
  return raw.filter((item): item is AgentRuntimeCandidate => {
    if (!item || typeof item !== 'object') return false
    const value = item as Partial<AgentRuntimeCandidate>
    return typeof value.candidateId === 'string' && typeof value.detectorId === 'string' && typeof value.provider === 'string'
      && typeof value.suggestedAgentId === 'string' && typeof value.name === 'string'
      && typeof value.executable === 'string' && Array.isArray(value.args)
      && value.args.every(argument => typeof argument === 'string')
      && Array.isArray(value.evidence) && Array.isArray(value.warnings)
      && ['exact', 'high', 'medium', 'low'].includes(value.identityConfidence ?? '')
      && (value.startability === undefined || ['not_tested', 'verified', 'failed'].includes(value.startability))
      && ['not_tested', 'verified', 'failed'].includes(value.protocolAvailability ?? '')
  }).map(candidate => ({
    ...candidate,
    startability: candidate.startability ?? 'not_tested',
  }))
}

function normalizeDiagnostics(raw: unknown): AgentDetectionDiagnostic[] {
  if (!Array.isArray(raw)) return []
  return raw.filter((item): item is AgentDetectionDiagnostic => {
    if (!item || typeof item !== 'object') return false
    const value = item as Partial<AgentDetectionDiagnostic>
    return typeof value.code === 'string' && value.code.trim().length > 0
      && typeof value.stage === 'string' && value.stage.trim().length > 0
      && (value.detectorId === undefined || typeof value.detectorId === 'string')
      && typeof value.message === 'string' && typeof value.retryable === 'boolean'
  })
}

export function normalizeAgentDetectionReport(raw: unknown): AgentDetectionReport {
  if (!raw || typeof raw !== 'object') {
    return { candidates: [], diagnostics: [], elapsedMs: 0, truncated: false }
  }
  const value = raw as Record<string, unknown>
  const elapsedMs = typeof value.elapsedMs === 'number' && Number.isFinite(value.elapsedMs) && value.elapsedMs >= 0
    ? Math.floor(value.elapsedMs)
    : 0
  return {
    candidates: normalizeAgentRuntimeCandidates(value.candidates),
    diagnostics: normalizeDiagnostics(value.diagnostics),
    elapsedMs,
    truncated: value.truncated === true,
  }
}
import { builtinAgentCatalog } from './agentCatalog.ts'
