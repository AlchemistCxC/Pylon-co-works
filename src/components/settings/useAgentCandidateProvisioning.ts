import { useRef, useState } from 'react'
import { appClients } from '../../app/appClients.ts'
import { errorCode as wireErrorCode } from '../../infrastructure/tauri/errorPayload.ts'
import { reportRuntimeError } from '../../app/runtimeError.ts'
import type { AgentsConfigDocument } from '../../infrastructure/acp/agentClient'
import type { AgentEntry } from '../../domains/identity/identityStore'
import { useIdentityStore } from '../../domains/identity/identityStore'
import type { AgentRuntimeCandidate } from '../../domains/agent/agentDetector.ts'
import { candidateImportMode, type AgentCandidateValidationState } from '../../domains/agent/candidateValidation.ts'
import { validateInvocation } from '../../domains/agent/invocationDraft.ts'
import { provisionAgentTransaction } from '../../application/transactions/provisionAgentTransaction.ts'
import { activateAgentSheet } from '../../workspace-sheets/activateAgentSheet.ts'
import { useWorkspaceStore } from '../../domains/workspace/workspaceStore.ts'

export interface CandidateDraft { id: string; name: string; executable: string; args: string[]; provider: string }

export function candidateDraft(candidate: AgentRuntimeCandidate): CandidateDraft {
  return { id: candidate.suggestedAgentId, name: candidate.name, executable: candidate.executable, args: [...candidate.args], provider: candidate.provider }
}

function invocationError(executable: string, args: string[]): string | null {
  const error = validateInvocation({ executable, args }).issues.find(issue => issue.severity === 'error')
  return error?.message ?? null
}

function detectedAgentConfig(draft: CandidateDraft, isFirst: boolean) {
  return {
    name: draft.name.trim(),
    provider: draft.provider.trim(),
    transport: 'subprocess' as const,
    exe: draft.executable.trim(),
    args: [...draft.args],
    default: isFirst,
  }
}

function agentsDocument(id: string, config: ReturnType<typeof detectedAgentConfig>): AgentsConfigDocument {
  return { agents: { [id]: config } }
}

/**
 * useAgentCandidateProvisioning — 候选编辑/验证/导入/激活流（A-V4 拆分自
 * AgentRuntimePanel，逻辑逐字随迁）：候选级草稿（编辑即作废验证）、ACP 验证、
 * provision 事务（验证并导入/未验证导入）、已导入候选的直接激活。
 * 单飞守卫（provisioning ref + 可见 id）防止双击重复供应。
 */
export function useAgentCandidateProvisioning(options: {
  agents: readonly AgentEntry[]
  reportPanelError: (operation: string, error: unknown, agentId?: string) => ReturnType<typeof reportRuntimeError>
  resolvePanelError: (operation: string, agentId?: string) => void
  reportConfigMutationError: (operation: string, error: unknown, agentId?: string) => unknown
  setFeedback: (message: string | null) => void
  setConfigConflict: (conflict: boolean) => void
  notify: (message: string) => void
  detectRuntimes: (force?: boolean) => Promise<void>
}) {
  const { agents, reportPanelError, resolvePanelError, reportConfigMutationError, setFeedback, setConfigConflict, notify, detectRuntimes } = options
  const [candidateValidation, setCandidateValidation] = useState<Record<string, AgentCandidateValidationState>>({})
  const [candidateDrafts, setCandidateDrafts] = useState<Record<string, CandidateDraft>>({})
  const [provisioningCandidateId, setProvisioningCandidateId] = useState<string | null>(null)
  const provisioningCandidateRef = useRef<string | null>(null)

  const validateCandidate = async (candidate: AgentRuntimeCandidate): Promise<AgentCandidateValidationState | null> => {
    const draft = candidateDrafts[candidate.candidateId] ?? candidateDraft(candidate)
    const invalid = invocationError(draft.executable, draft.args)
    if (invalid) { setFeedback(invalid); return null }
    setFeedback(null)
    setCandidateValidation(current => ({ ...current, [candidate.candidateId]: { status: 'testing' } }))
    let reportedTransportFailure = false
    const result = await appClients.agent().testAgentCandidate(draft.id, {
      name: draft.name, provider: draft.provider, transport: 'subprocess', exe: draft.executable, args: [...draft.args],
    }).catch(error => {
      const detail = reportPanelError('验证 Agent 候选', error, draft.id)
      reportedTransportFailure = true
      return {
        ok: false,
        agentId: draft.id,
        durationMs: 0,
        error: { code: detail.code ?? 'agent_validation_transport_failed', message: detail.message, action: 'open-runtime-log', stage: 'unknown' as const, exitCode: null, stderr: null },
      }
    })
    const validation: AgentCandidateValidationState = { status: result.ok ? 'ok' : 'failed', result }
    if (result.ok) resolvePanelError('验证 Agent 候选', draft.id)
    else if (!reportedTransportFailure) reportPanelError('验证 Agent 候选', result.error ?? new Error('Agent 候选验证失败'), draft.id)
    setCandidateValidation(current => ({ ...current, [candidate.candidateId]: validation }))
    return validation
  }

  const importCandidate = async (candidate: AgentRuntimeCandidate, validationOverride?: AgentCandidateValidationState) => {
    const validation = validationOverride ?? candidateValidation[candidate.candidateId]
    const importMode = candidateImportMode(candidate, validation)
    if (importMode === 'blocked') {
      setFeedback(validation?.status === 'failed'
        ? '该候选置信度不足，必须通过 ACP 验证后才能导入'
        : '请先验证候选，再执行导入')
      return
    }
    const draft = candidateDrafts[candidate.candidateId] ?? candidateDraft(candidate)
    const base = draft.id.trim()
    if (!base || !draft.name.trim() || !draft.executable.trim()) { setFeedback('候选 id / name / exe 不能为空'); return }
    const invalid = invocationError(draft.executable, draft.args)
    if (invalid) { setFeedback(invalid); return }
    let id = base; let suffix = 2
    while (agents.some(agent => agent.id === id)) id = `${base}-${suffix++}`
    const config = detectedAgentConfig(draft, agents.length === 0)
    try {
      const result = await provisionAgentTransaction({
        candidateId: candidate.candidateId,
        agentId: id,
        name: draft.name.trim(),
        provider: draft.provider.trim(),
        executable: draft.executable.trim(),
        args: [...draft.args],
      }, {
        validate: () => appClients.agent().testAgentCandidate(id, {
          name: draft.name.trim(), provider: draft.provider.trim(), transport: 'subprocess', exe: draft.executable.trim(), args: [...draft.args],
        }),
        persist: async () => {
          try {
            await appClients.agent().createAgent(id, config)
          } catch (error) {
            if (wireErrorCode(error) !== 'config_read_only') throw error
            await appClients.agent().initializeAgentsConfig(id, agentsDocument(id, config))
          }
        },
        refreshAgents: () => appClients.agent().listAgents(),
        applyAgents: list => useIdentityStore.getState().setAgents(list),
        activate: (agentId, agentName) => activateAgentSheet(agentId, agentName, () => {
          useWorkspaceStore.getState().openSheet({ kind: 'agent', title: agentName, agentId })
        }),
      }, {
        validation: validation?.status === 'ok' || validation?.status === 'failed' ? validation.result : undefined,
        acceptUnverified: importMode === 'unverified',
      })
      setConfigConflict(false)
      if (result.kind === 'validation-failed') {
        setFeedback(result.validation.error?.message ?? 'Agent 候选验证失败')
        return
      }
      if (result.kind === 'stored-not-active') {
        setFeedback(`已保存 ${draft.name}（${id}），但尚未连接。请检查运行时日志后重试。`)
      } else {
        setFeedback(null)
        resolvePanelError('导入 Agent 候选', id)
        notify(`已导入并打开 ${draft.name}（${id}）${importMode === 'unverified' ? '；状态：未验证' : ''}`)
      }
      await detectRuntimes()
    } catch (error) {
      reportConfigMutationError('导入 Agent 候选', error, id)
    }
  }

  const validateAndImportCandidate = async (candidate: AgentRuntimeCandidate) => {
    if (provisioningCandidateRef.current) return
    provisioningCandidateRef.current = candidate.candidateId
    setProvisioningCandidateId(candidate.candidateId)
    try {
      const validation = await validateCandidate(candidate)
      if (validation?.status === 'ok') await importCandidate(candidate, validation)
    } finally {
      provisioningCandidateRef.current = null
      setProvisioningCandidateId(null)
    }
  }

  const importUnverifiedCandidate = async (candidate: AgentRuntimeCandidate) => {
    if (provisioningCandidateRef.current) return
    provisioningCandidateRef.current = candidate.candidateId
    setProvisioningCandidateId(candidate.candidateId)
    try {
      await importCandidate(candidate)
    } finally {
      provisioningCandidateRef.current = null
      setProvisioningCandidateId(null)
    }
  }

  const activateImportedCandidate = async (candidate: AgentRuntimeCandidate) => {
    const agentId = candidate.alreadyImportedAgentId
    if (!agentId || provisioningCandidateRef.current) return
    provisioningCandidateRef.current = candidate.candidateId
    setProvisioningCandidateId(candidate.candidateId)
    const agentName = agents.find(agent => agent.id === agentId)?.name ?? candidate.name
    try {
      const activated = await activateAgentSheet(agentId, agentName, () => {
        useWorkspaceStore.getState().openSheet({ kind: 'agent', title: agentName, agentId })
      })
      if (activated) {
        setFeedback(null)
        notify(`已打开 ${agentName}`)
      } else {
        setFeedback(`${agentName} 尚未连接，请检查可执行文件或运行时日志。`)
      }
    } finally {
      provisioningCandidateRef.current = null
      setProvisioningCandidateId(null)
    }
  }

  const updateCandidateDraft = (candidate: AgentRuntimeCandidate, patch: Partial<CandidateDraft>) => {
    setCandidateDrafts(current => ({ ...current, [candidate.candidateId]: { ...(current[candidate.candidateId] ?? candidateDraft(candidate)), ...patch } }))
    setCandidateValidation(current => {
      const next = { ...current }
      delete next[candidate.candidateId]
      return next
    })
  }

  return {
    candidateValidation, candidateDrafts, provisioningCandidateId,
    validateAndImportCandidate, importUnverifiedCandidate, activateImportedCandidate, updateCandidateDraft,
  }
}
