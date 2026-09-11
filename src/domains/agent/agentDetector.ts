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
  providers: AgentProviderEvidence[]
  preflight: AgentProviderPreflight[]
  diagnostics: AgentDetectionDiagnostic[]
  elapsedMs: number
  truncated: boolean
}

/** Presence of one command name on the ACP or the vendor-CLI side. */
export interface AgentEvidenceHit { kind: string; path: string; source: string }

/** Per-provider dual evidence: an ACP candidate may be absent while the vendor
 * CLI (and the shared config dir) is present — that is how "adapterMissing" is
 * observable at all. */
export interface AgentProviderEvidence {
  provider: string
  detectorId: string
  adapterRelationDeclared: boolean
  acpCommands: AgentEvidenceHit[]
  nativeCommands: AgentEvidenceHit[]
  sharedConfigPresent: boolean
}

/** Stable provider-level installation state (backend `PreflightStatus`). */
export type AgentInstallStatus = 'installed' | 'adapterMissing' | 'nativeMissing' | 'versionTooOld' | 'configOnly' | 'notInstalled'

type AgentCheckStatus = 'PASS' | 'FAIL' | 'WARN'

export interface AgentPreflightCheck {
  checkId: string
  label: string
  status: AgentCheckStatus
  message: string
  fixes: { kind: string; payload: string }[]
}

/** Wrapper explainer: the vendor CLI vs the ACP entry point Pylon launches. */
export interface AgentAdapterEvidence {
  nativeCmd: string
  nativeLabel: string
  nativePresent: boolean
  acpPresent: boolean
  sharedConfigDir: string
  sharedConfigPresent: boolean
  docsUrl?: string | null
}

/**
 * Why a provider is in `status` — the backend's closed diagnosis vocabulary.
 *
 * A status name cannot distinguish "not installed" from "installed somewhere
 * this process cannot see", and users read the second as the app being broken.
 * `summary` is a ready-to-render actionable sentence produced by the same pure
 * function the CLI uses, so panel and CLI cannot disagree.
 */
export interface AgentDiagnosticCause {
  level: AgentDiagnosticLevel
  code: string
  summary: string
}

export type AgentDiagnosticLevel = 'ok' | 'info' | 'warn' | 'fail'

const DIAGNOSTIC_LEVELS: readonly AgentDiagnosticLevel[] = ['ok', 'info', 'warn', 'fail']

/**
 * Normalize the diagnosis. An unrecognized level is dropped rather than
 * rendered: a cause the UI cannot rank must not reach the user as a silently
 * mis-coloured severity. Dropping it makes the panel fall back to the static
 * status wording, which is strictly better than a wrong-level blank.
 */
function normalizeDiagnosticCause(raw: unknown): AgentDiagnosticCause | null {
  if (!raw || typeof raw !== 'object') return null
  const value = raw as Partial<AgentDiagnosticCause>
  if (!DIAGNOSTIC_LEVELS.includes(value.level as AgentDiagnosticLevel)) return null
  if (typeof value.code !== 'string' || value.code.trim().length === 0) return null
  if (typeof value.summary !== 'string' || value.summary.trim().length === 0) return null
  return {
    level: value.level as AgentDiagnosticLevel,
    code: value.code,
    summary: value.summary,
  }
}

export interface AgentProviderPreflight {
  provider: string
  status: AgentInstallStatus
  passed: boolean
  adapter?: AgentAdapterEvidence | null
  checks: AgentPreflightCheck[]
  /** Present when the backend explained why; absent otherwise. */
  cause?: AgentDiagnosticCause | null
}

/**
 * Actionable reason for a non-installed state, mirroring the backend's closed
 * `action_code` vocabulary. The wording lives here so it is localizable, but the
 * vocabulary is closed: an unknown status cannot silently render as "OK".
 */
export function agentInstallStatusReason(status: AgentInstallStatus): string {
  switch (status) {
    case 'installed': return ''
    case 'adapterMissing': return '未找到 ACP 适配器（Agent 本体已安装）；请安装该 Agent 的 ACP 适配器，或改选已安装的适配器可执行文件'
    case 'nativeMissing': return '未找到该适配器包装的官方 CLI；若适配器自带运行时可继续，否则请先安装它'
    case 'versionTooOld': return 'ACP 适配器版本低于该 Agent 要求的最低版本；请升级适配器'
    case 'configOnly': return '只找到配置文件、未找到可执行文件；请指定可执行文件路径'
    case 'notInstalled': return '未检测到该 Agent；请先安装，或在下方手动添加'
  }
}

export function agentInstallStatusLabel(status: AgentInstallStatus): string {
  switch (status) {
    case 'installed': return '已安装'
    case 'adapterMissing': return '缺 ACP 适配器'
    case 'nativeMissing': return '缺官方 CLI'
    case 'versionTooOld': return '版本过低'
    case 'configOnly': return '仅配置'
    case 'notInstalled': return '未安装'
  }
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

const INSTALL_STATUSES: readonly AgentInstallStatus[] = ['installed', 'adapterMissing', 'nativeMissing', 'versionTooOld', 'configOnly', 'notInstalled']

function normalizeEvidenceHits(raw: unknown): AgentEvidenceHit[] {
  if (!Array.isArray(raw)) return []
  return raw.filter((item): item is AgentEvidenceHit => {
    if (!item || typeof item !== 'object') return false
    const value = item as Partial<AgentEvidenceHit>
    return typeof value.kind === 'string' && typeof value.path === 'string' && typeof value.source === 'string'
  })
}

function normalizeProviderEvidence(raw: unknown): AgentProviderEvidence[] {
  if (!Array.isArray(raw)) return []
  return raw.filter((item): item is AgentProviderEvidence => {
    if (!item || typeof item !== 'object') return false
    const value = item as Partial<AgentProviderEvidence>
    return typeof value.provider === 'string' && value.provider.trim().length > 0
      && typeof value.detectorId === 'string'
      && typeof value.adapterRelationDeclared === 'boolean'
      && typeof value.sharedConfigPresent === 'boolean'
      && Array.isArray(value.acpCommands) && Array.isArray(value.nativeCommands)
  }).map(entry => ({
    ...entry,
    acpCommands: normalizeEvidenceHits(entry.acpCommands),
    nativeCommands: normalizeEvidenceHits(entry.nativeCommands),
  }))
}

function normalizePreflightChecks(raw: unknown): AgentPreflightCheck[] {
  if (!Array.isArray(raw)) return []
  return raw.filter((item): item is AgentPreflightCheck => {
    if (!item || typeof item !== 'object') return false
    const value = item as Partial<AgentPreflightCheck>
    return typeof value.checkId === 'string' && typeof value.label === 'string'
      && typeof value.message === 'string'
      && ['PASS', 'FAIL', 'WARN'].includes(value.status ?? '')
      && Array.isArray(value.fixes)
  })
}

/**
 * Normalize the backend preflight projection. A provider whose status is not in
 * the closed vocabulary is dropped rather than rendered as a generic "unknown":
 * a status the UI cannot explain must not reach the user as a silent blank.
 */
function normalizeProviderPreflight(raw: unknown): AgentProviderPreflight[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((item): AgentProviderPreflight[] => {
    if (!item || typeof item !== 'object') return []
    const value = item as Partial<AgentProviderPreflight>
    if (typeof value.provider !== 'string' || value.provider.trim().length === 0) return []
    if (!INSTALL_STATUSES.includes(value.status as AgentInstallStatus)) return []
    if (typeof value.passed !== 'boolean') return []
    const adapter = value.adapter
    const normalizedAdapter: AgentAdapterEvidence | null = adapter && typeof adapter === 'object'
      && typeof adapter.nativeCmd === 'string' && typeof adapter.nativeLabel === 'string'
      && typeof adapter.nativePresent === 'boolean' && typeof adapter.acpPresent === 'boolean'
      && typeof adapter.sharedConfigDir === 'string' && typeof adapter.sharedConfigPresent === 'boolean'
      ? adapter as AgentAdapterEvidence
      : null
    return [{
      provider: value.provider,
      status: value.status as AgentInstallStatus,
      passed: value.passed,
      adapter: normalizedAdapter,
      checks: normalizePreflightChecks(value.checks),
      cause: normalizeDiagnosticCause(value.cause),
    }]
  })
}

export function normalizeAgentDetectionReport(raw: unknown): AgentDetectionReport {
  if (!raw || typeof raw !== 'object') {
    return { candidates: [], providers: [], preflight: [], diagnostics: [], elapsedMs: 0, truncated: false }
  }
  const value = raw as Record<string, unknown>
  const elapsedMs = typeof value.elapsedMs === 'number' && Number.isFinite(value.elapsedMs) && value.elapsedMs >= 0
    ? Math.floor(value.elapsedMs)
    : 0
  return {
    candidates: normalizeAgentRuntimeCandidates(value.candidates),
    providers: normalizeProviderEvidence(value.providers),
    preflight: normalizeProviderPreflight(value.preflight),
    diagnostics: normalizeDiagnostics(value.diagnostics),
    elapsedMs,
    truncated: value.truncated === true,
  }
}
import { builtinAgentCatalog } from './agentCatalog.ts'
