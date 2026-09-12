import type { AgentRuntimeCandidate } from './agentDetector.ts'

export type AgentCandidateValidationStage = 'preflight' | 'spawn' | 'initialize' | 'capability' | 'timeout' | 'unknown'

export interface AgentCandidateValidationError {
  code: string
  message: string
  action: 'select_executable' | 'open-runtime-log' | string
  stage?: AgentCandidateValidationStage
  exitCode?: number | null
  stderr?: string | null
  retryable?: boolean
  ioKind?: string | null
  remoteCode?: number | null
  remoteDataSummary?: string | null
}

/** B1：连接测试响应携带的启动计划视图（与真实 spawn 同一 planner 计算；env 值已掩码）。 */
export interface AgentLaunchPlanView {
  provider: string
  executable: string
  argv: string[]
  cwd: string | null
  env: { name: string; value: string }[]
  diagnostics: { code: string; stage: string; message: string }[]
}

export interface AgentCandidateValidationResult {
  ok: boolean
  agentId: string
  durationMs: number
  error?: AgentCandidateValidationError | null
  /** 计划失败（如未知 provider 的 Windows 门槛）时为 `{ error }`，无计划字段。 */
  launchPlan?: AgentLaunchPlanView | { error: string } | null
}

export interface AgentCandidateValidationState {
  status: 'testing' | 'ok' | 'failed'
  result?: AgentCandidateValidationResult
}

export type CandidateImportMode = 'blocked' | 'verified' | 'unverified'

/**
 * high/exact 候选有版本探针等强证据：完成过验证但握手失败后允许用户显式导入。
 * medium/low 证据不足，必须拿到一次成功握手；所有候选在尚未验证时都保持阻止。
 */
export function candidateImportMode(
  candidate: Pick<AgentRuntimeCandidate, 'identityConfidence'>,
  validation: AgentCandidateValidationState | undefined,
): CandidateImportMode {
  if (validation?.status === 'ok') return 'verified'
  if (validation?.status === 'failed' && (candidate.identityConfidence === 'exact' || candidate.identityConfidence === 'high')) return 'unverified'
  return 'blocked'
}

const STAGE_LABELS: Record<AgentCandidateValidationStage, string> = {
  preflight: '启动前检查',
  spawn: '启动进程',
  initialize: '初始化握手',
  capability: '能力协商',
  timeout: '总超时',
  unknown: '未判定',
}

/** Normalize the native connection-test envelope at the typed client boundary. */
export function normalizeAgentCandidateValidationResult(raw: unknown, fallbackAgentId = ''): AgentCandidateValidationResult {
  const value = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  const errorValue = value.error && typeof value.error === 'object' ? value.error as Record<string, unknown> : null
  const rawStage = errorValue?.stage
  const stage: AgentCandidateValidationStage = typeof rawStage === 'string'
    && ['preflight', 'spawn', 'initialize', 'capability', 'timeout'].includes(rawStage)
    ? rawStage as AgentCandidateValidationStage
    : 'unknown'
  const error = errorValue ? {
    code: typeof errorValue.code === 'string' ? errorValue.code : 'agent_validation_failed',
    message: typeof errorValue.message === 'string' ? errorValue.message : 'Agent ACP 验证失败',
    action: typeof errorValue.action === 'string' ? errorValue.action : 'open-runtime-log',
    stage,
    exitCode: typeof errorValue.exitCode === 'number' ? errorValue.exitCode : null,
    stderr: typeof errorValue.stderr === 'string' ? errorValue.stderr : null,
    retryable: typeof errorValue.retryable === 'boolean' ? errorValue.retryable : undefined,
    ioKind: typeof errorValue.ioKind === 'string' ? errorValue.ioKind : null,
    remoteCode: typeof errorValue.remoteCode === 'number' ? errorValue.remoteCode : null,
    remoteDataSummary: typeof errorValue.remoteDataSummary === 'string' ? errorValue.remoteDataSummary : null,
  } : null
  return {
    ok: value.ok === true,
    agentId: typeof value.agentId === 'string' ? value.agentId : fallbackAgentId,
    durationMs: typeof value.durationMs === 'number' && Number.isFinite(value.durationMs) && value.durationMs >= 0 ? Math.floor(value.durationMs) : 0,
    error,
    launchPlan: normalizeLaunchPlanView(value.launchPlan),
  }
}

/**
 * B1：连接测试响应里的启动计划视图。形状不可信即整体丢弃（null）——它只是
 * 展示性证据，丢弃后 UI 不渲染该行，远好过渲染半截计划误导用户。
 */
function normalizeLaunchPlanView(raw: unknown): AgentLaunchPlanView | null {
  if (!raw || typeof raw !== 'object') return null
  const value = raw as Record<string, unknown>
  const argv = Array.isArray(value.argv) && value.argv.every(item => typeof item === 'string')
    ? value.argv as string[]
    : null
  if (typeof value.executable !== 'string' || argv === null) return null
  const env = Array.isArray(value.env)
    ? value.env.flatMap((item): { name: string; value: string }[] => {
        if (!item || typeof item !== 'object') return []
        const entry = item as Record<string, unknown>
        return typeof entry.name === 'string' && typeof entry.value === 'string'
          ? [{ name: entry.name, value: entry.value }]
          : []
      })
    : []
  const diagnostics = Array.isArray(value.diagnostics)
    ? value.diagnostics.flatMap((item): { code: string; stage: string; message: string }[] => {
        if (!item || typeof item !== 'object') return []
        const entry = item as Record<string, unknown>
        return typeof entry.code === 'string' && typeof entry.stage === 'string' && typeof entry.message === 'string'
          ? [{ code: entry.code, stage: entry.stage, message: entry.message }]
          : []
      })
    : []
  return {
    provider: typeof value.provider === 'string' ? value.provider : '',
    executable: value.executable,
    argv,
    cwd: typeof value.cwd === 'string' ? value.cwd : null,
    env,
    diagnostics,
  }
}

function formatDuration(durationMs: number): string {
  return durationMs >= 1000 ? `${(durationMs / 1000).toFixed(1)}s` : `${durationMs}ms`
}

export function candidateValidationDetails(validation: AgentCandidateValidationState): {
  headline: string
  duration: string
  stage: string
  exitCode: string
  stderr: string
  message: string
} | null {
  const result = validation.result
  if (!result) return null
  const error = result.error
  return {
    headline: result.ok ? 'ACP 验证成功' : 'ACP 验证失败',
    duration: formatDuration(result.durationMs),
    stage: STAGE_LABELS[error?.stage ?? 'unknown'],
    exitCode: typeof error?.exitCode === 'number' ? String(error.exitCode) : '未提供',
    stderr: error?.stderr?.trim() || '未捕获到 stderr',
    message: error?.message ?? '',
  }
}
