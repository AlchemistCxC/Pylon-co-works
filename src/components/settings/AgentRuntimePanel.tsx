import { useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { IS_TAURI } from '../../infrastructure/tauri/env'
import {
  createAgentClient,
  type AgentCreateConfig,
  type AgentsConfigDocument,
} from '../../infrastructure/acp/agentClient'
import { reportRuntimeError } from '../../runtimeError'
import { useIdentityStore, type AgentEntry } from '../../identityStore'
import { useRuntimeStore } from '../../runtimeStore'
import { selectAgentStatus, statusLabel } from './agentTypes'
import { getPluginServiceRegistry } from '../../plugin-runtime/runtimeServices.ts'
import { selectAcpRuntimeDetectorIds, type AgentDetectionDiagnostic, type AgentRuntimeCandidate, type AgentRuntimeDetectorMetadata, type AgentStartability } from '../../domains/agent/agentDetector.ts'
import {
  candidateImportMode,
  candidateValidationDetails,
  type AgentCandidateValidationState,
} from '../../domains/agent/candidateValidation.ts'
import ArgumentListEditor from './ArgumentListEditor.tsx'
import { describeInvocation, validateInvocation } from '../../domains/agent/invocationDraft.ts'
import { builtinAgentCatalog } from '../../domains/agent/agentCatalog.ts'
import { provisionAgentTransaction } from '../../application/transactions/provisionAgentTransaction.ts'
import { activateAgentSheet } from '../../workspace-sheets/activateAgentSheet.ts'
import { useWorkspaceStore } from '../../workspaceStore.ts'

interface Draft {
  name: string
  exe: string
  provider: string
  args: string[]
  effectiveSuffix: string[]
  argsKnown: boolean
}

interface CandidateDraft { id: string; name: string; executable: string; args: string[]; provider: string }

function emptyDraft(agent?: AgentEntry): Draft {
  const args = agent?.args ? [...agent.args] : []
  const effectiveArgs = agent?.effectiveArgs ?? args
  const hasMatchingPrefix = args.every((argument, index) => effectiveArgs[index] === argument)
  return {
    name: agent?.name ?? '',
    exe: agent?.exe ?? '',
    provider: agent?.provider ?? '',
    args,
    effectiveSuffix: hasMatchingPrefix ? effectiveArgs.slice(args.length) : [],
    argsKnown: agent?.args !== undefined,
  }
}

function agentConfig(name: string, exe: string, args: readonly string[], provider: string, isFirst: boolean): AgentCreateConfig {
  return {
    name: name.trim(),
    provider: provider.trim() || 'custom',
    transport: 'subprocess',
    exe: exe.trim(),
    args: [...args],
    default: isFirst,
  }
}

function candidateDraft(candidate: AgentRuntimeCandidate): CandidateDraft {
  return { id: candidate.suggestedAgentId, name: candidate.name, executable: candidate.executable, args: [...candidate.args], provider: candidate.provider }
}

function detectedAgentConfig(draft: CandidateDraft, isFirst: boolean): AgentCreateConfig {
  return {
    name: draft.name.trim(),
    provider: draft.provider.trim(),
    transport: 'subprocess',
    exe: draft.executable.trim(),
    args: [...draft.args],
    default: isFirst,
  }
}

function agentsDocument(id: string, config: AgentCreateConfig): AgentsConfigDocument {
  return { agents: { [id]: config } }
}

function executableIdentity(path: string): { id: string; name: string } {
  const fileName = path.trim().split(/[\\/]/).pop()?.replace(/\.(?:exe|cmd|bat)$/i, '').trim() ?? ''
  const id = fileName
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '') || 'agent'
  return { id, name: fileName || 'Agent' }
}

function wireErrorCode(error: unknown): string | undefined {
  if (error && typeof error === 'object') return (error as { code?: unknown }).code as string | undefined
  return undefined
}

function invocationError(executable: string, args: string[]): string | null {
  const error = validateInvocation({ executable, args }).issues.find(issue => issue.severity === 'error')
  return error?.message ?? null
}

function InvocationPreview({ executable, args, effectiveArgs = args }: {
  executable: string
  args: string[]
  effectiveArgs?: string[]
}) {
  const invocation = describeInvocation({ executable, args }, effectiveArgs)
  return (
    <div className="agent-invocation-preview">
      <div className="set-hint">实际启动：<code>{invocation.display}</code></div>
      {invocation.validation.issues.map(issue => (
        <div className="set-hint" role={issue.severity === 'error' ? 'alert' : 'note'} key={`${issue.code}:${issue.argumentIndex ?? 'exe'}`}>
          {issue.severity === 'error' ? '错误' : '提示'}：{issue.message}
        </div>
      ))}
    </div>
  )
}

function candidateProtocolLabel(validation: AgentCandidateValidationState | undefined): string {
  if (validation?.status === 'testing') return '验证中'
  if (validation?.status === 'ok') return '可用'
  if (validation?.status === 'failed') return '失败'
  return '未验证'
}

function candidateStartabilityLabel(startability: AgentStartability | undefined): string {
  if (startability === 'verified') return '可启动'
  if (startability === 'failed') return '启动失败'
  return '未探测'
}

function activationLabel(state: AgentEntry['configActivationState']): string {
  return state === 'activated' ? '已生效' : state === 'pendingRestart' ? '待重启生效' : '已存储'
}

/** 按 provider 给 exe/命令路径填写引导（任务：说明 hermes/peri 分别填什么路径）。 */
function pathHintForProvider(provider: string | null | undefined): string {
  switch ((provider ?? '').trim().toLowerCase()) {
    case 'hermes':
      return 'Hermes 填法：exe 填 hermes 命令名（在 PATH 中）或 Hermes 启动脚本绝对路径；若需固定 provider/密钥，再补 hermes_profile（profile 名或目录）。'
    case 'peri':
      return 'Peri 填法：exe 填 peri.exe 的绝对路径，例如 F:\\A-I\\Agent\\Peri\\target\\release\\peri.exe（PATH 内也可只填 peri）。'
    default:
      return 'exe 填法：Agent 可执行文件绝对路径；PATH 内的命令（claude、hermes、peri 等）也可只填命令名。'
  }
}

/**
 * 施工文档 §4.1：Agent 运行时配置面板。
 * 复用既有 Settings agent section 边界；结构化操作（exe/name/provider/default/新建/测试）
 * 全部走 typed client，不重建整块 YAML。
 */
export default function AgentRuntimePanel({ initialAgentId }: { initialAgentId?: string }) {
  const [agentClient] = useState(() => createAgentClient({
    invoke: (cmd, args) => invoke(cmd, args as Record<string, unknown> | undefined),
  }))
  const agents = useIdentityStore(s => s.agents)
  const activeAgent = useIdentityStore(s => s.activeAgent)
  const agentStatuses = useRuntimeStore(s => s.agentStatuses)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState<Draft>(emptyDraft())
  const [savingId, setSavingId] = useState<string | null>(null)
  const [testingId, setTestingId] = useState<string | null>(null)
  const [testResult, setTestResult] = useState<Record<string, string>>({})
  const [showCreate, setShowCreate] = useState(false)
  const [createDraft, setCreateDraft] = useState({ id: '', name: '', exe: '', provider: 'custom', args: ['acp'] })
  const [feedback, setFeedback] = useState<string | null>(null)
  const [configConflict, setConfigConflict] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  // 轻量操作提示：保存/新建/导入成功等「需要弹出」的反馈走 toast，自动消失；
  // 压缩/校验等详情性提示仍走 setFeedback 内联。
  const notify = (message: string) => {
    setToast(message)
    window.setTimeout(() => setToast(null), 2500)
  }
  const [candidates, setCandidates] = useState<AgentRuntimeCandidate[]>([])
  const [selectedCandidateId, setSelectedCandidateId] = useState<string | null>(null)
  const [detectionDiagnostics, setDetectionDiagnostics] = useState<AgentDetectionDiagnostic[]>([])
  const [detectionElapsedMs, setDetectionElapsedMs] = useState(0)
  const [detectionTruncated, setDetectionTruncated] = useState(false)
  const [detectionCompleted, setDetectionCompleted] = useState(false)
  const [detecting, setDetecting] = useState(false)
  const [candidateValidation, setCandidateValidation] = useState<Record<string, AgentCandidateValidationState>>({})
  const [candidateDrafts, setCandidateDrafts] = useState<Record<string, CandidateDraft>>({})
  const [provisioningCandidateId, setProvisioningCandidateId] = useState<string | null>(null)
  const provisioningCandidateRef = useRef<string | null>(null)
  const focusedInitialAgentRef = useRef<string | null>(null)

  const reportConfigMutationError = (operation: string, error: unknown, agentId?: string) => {
    const detail = reportRuntimeError(operation, error, agentId)
    if (wireErrorCode(error) === 'config_revision_conflict') {
      setConfigConflict(true)
      setFeedback('配置已被其他进程修改；你的草稿仍保留。请重新载入配置后再提交。')
      return detail
    }
    setFeedback(`${operation}失败：${detail.message}`)
    return detail
  }

  const reloadConfigSnapshot = async () => {
    try {
      await agentClient.agentConfigSnapshot()
      await refreshAgents()
      setConfigConflict(false)
      setFeedback('配置已重新载入；未提交草稿仍保留。')
    } catch (error) {
      const detail = reportRuntimeError('重新载入 Agent 配置', error)
      setFeedback(`重新载入失败：${detail.message}`)
    }
  }

  const detectRuntimes = async () => {
    if (detecting) return
    setDetecting(true)
    setDetectionCompleted(false)
    try {
      const registered = getPluginServiceRegistry().list<AgentRuntimeDetectorMetadata>('agent-detector')
      const detectors = registered.length > 0 ? registered : builtinAgentCatalog.detectors()
      const report = await agentClient.detectAgentRuntimes(selectAcpRuntimeDetectorIds(detectors))
      setCandidates(report.candidates)
      setSelectedCandidateId(current => report.candidates.some(candidate => candidate.candidateId === current)
        ? current
        : report.candidates.find(candidate => !candidate.alreadyImportedAgentId)?.candidateId ?? report.candidates[0]?.candidateId ?? null)
      setDetectionDiagnostics(report.diagnostics)
      setDetectionElapsedMs(report.elapsedMs)
      setDetectionTruncated(report.truncated)
      setDetectionCompleted(true)
    } catch (error) {
      reportRuntimeError('探测本机 Agent', error)
      setFeedback(`探测失败：${error instanceof Error ? error.message : String(error)}`)
    } finally { setDetecting(false) }
  }

  useEffect(() => {
    void detectRuntimes()
    // 首次进入 Agent 配置即扫描一次；后续扫描仍由“重新探测”显式触发。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const validateCandidate = async (candidate: AgentRuntimeCandidate): Promise<AgentCandidateValidationState | null> => {
    const draft = candidateDrafts[candidate.candidateId] ?? candidateDraft(candidate)
    const invalid = invocationError(draft.executable, draft.args)
    if (invalid) { setFeedback(invalid); return null }
    setFeedback(null)
    setCandidateValidation(current => ({ ...current, [candidate.candidateId]: { status: 'testing' } }))
    const result = await agentClient.testAgentCandidate(draft.id, {
      name: draft.name, provider: draft.provider, transport: 'subprocess', exe: draft.executable, args: [...draft.args],
    }).catch(error => {
      const detail = reportRuntimeError('验证 Agent 候选', error)
      return {
        ok: false,
        agentId: draft.id,
        durationMs: 0,
        error: { code: detail.code ?? 'agent_validation_transport_failed', message: detail.message, action: 'open-runtime-log', stage: 'unknown' as const, exitCode: null, stderr: null },
      }
    })
    const validation: AgentCandidateValidationState = { status: result.ok ? 'ok' : 'failed', result }
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
        validate: () => agentClient.testAgentCandidate(id, {
          name: draft.name.trim(), provider: draft.provider.trim(), transport: 'subprocess', exe: draft.executable.trim(), args: [...draft.args],
        }),
        persist: async () => {
          try {
            await agentClient.createAgent(id, config)
          } catch (error) {
            if (wireErrorCode(error) !== 'config_read_only') throw error
            await agentClient.initializeAgentsConfig(id, agentsDocument(id, config))
          }
        },
        refreshAgents: () => agentClient.listAgents(),
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

  const refreshAgents = async () => {
    const list = await agentClient.listAgents()
    useIdentityStore.getState().setAgents(list)
  }

  const startEdit = (agent: AgentEntry) => {
    setEditingId(agent.id)
    setDraft(emptyDraft(agent))
    setFeedback(null)
  }

  useEffect(() => {
    if (!initialAgentId || focusedInitialAgentRef.current === initialAgentId) return
    const target = agents.find(agent => agent.id === initialAgentId)
    if (!target) return
    focusedInitialAgentRef.current = initialAgentId
    setEditingId(target.id)
    setDraft(emptyDraft(target))
    setFeedback('请重新选择或修正该 Agent 的可执行文件。')
  }, [agents, initialAgentId])

  const pickExecutable = async (): Promise<string | null> => {
    if (IS_TAURI) {
      const { open } = await import('@tauri-apps/plugin-dialog')
      const selected = await open({
        multiple: false,
        directory: false,
        filters: [{ name: '可执行文件', extensions: ['exe', 'cmd', 'bat'] }],
      })
      return typeof selected === 'string' ? selected : null
    }
    // 浏览器 mock：可控替代行为（测试注入 prompt 返回值）。
    return window.prompt('输入可执行文件路径（exe/cmd/bat）')
  }

  const saveEdit = async (agentId: string) => {
    if (savingId) return
    const invalid = invocationError(draft.exe, draft.args)
    if (invalid) { setFeedback(invalid); return }
    setSavingId(agentId)
    setFeedback(null)
    try {
      await agentClient.ensureConfigRevision()
      await agentClient.updateAgentFieldPatch(agentId, {
        name: draft.name,
        exe: draft.exe,
        provider: draft.provider.trim() || null,
        ...(draft.argsKnown ? { args: [...draft.args] } : {}),
      })
      await refreshAgents()
      setEditingId(null)
      setConfigConflict(false)
      setFeedback(null)
      notify(`已保存 ${agentId}`)
    } catch (error) {
      reportConfigMutationError('保存 Agent 字段', error, agentId)
      notify(`保存失败：${agentId}`)
    } finally {
      setSavingId(null)
    }
  }

  const setDefault = async (agentId: string) => {
    if (savingId) return
    setSavingId(agentId)
    setFeedback(null)
    try {
      await agentClient.ensureConfigRevision()
      try {
        await agentClient.updateAgentFieldPatch(agentId, { default: true })
      } catch (error) {
        if (wireErrorCode(error) !== 'config_read_only') throw error
        await agentClient.initializeAgentFieldPatch(agentId, { default: true })
      }
      await refreshAgents()
      setConfigConflict(false)
      setFeedback(null)
      notify(`已将 ${agentId} 设为默认`)
    } catch (error) {
      reportConfigMutationError('设置默认 Agent', error, agentId)
    } finally {
      setSavingId(null)
    }
  }

  const testConnection = async (agentId: string) => {
    if (testingId) return
    setTestingId(agentId)
    setTestResult(prev => ({ ...prev, [agentId]: '测试中…' }))
    try {
      const result = await agentClient.testAgentConnection(agentId)
      setTestResult(prev => ({
        ...prev,
        [agentId]: result.ok
          ? `连接成功（${result.durationMs}ms）`
          : `连接失败：${result.error?.message ?? '未知错误'}`,
      }))
    } catch (error) {
      const detail = reportRuntimeError('测试 Agent 连接', error, agentId)
      setTestResult(prev => ({ ...prev, [agentId]: detail.message }))
    } finally {
      setTestingId(null)
    }
  }

  const restartRuntime = async (agentId: string) => {
    if (savingId) return
    setSavingId(agentId)
    setFeedback(null)
    try {
      await agentClient.restartAgentRuntime(agentId)
      await refreshAgents()
      notify(`已重启 ${agentId} 并应用配置`)
    } catch (error) {
      reportConfigMutationError('重启 Agent runtime', error, agentId)
    } finally {
      setSavingId(null)
    }
  }

  const createAgent = async () => {
    if (savingId) return
    const id = createDraft.id.trim()
    if (!id || !createDraft.name.trim() || !createDraft.exe.trim()) {
      setFeedback('新建 Agent 必须填写 id / name / exe')
      return
    }
    const invalid = invocationError(createDraft.exe, createDraft.args)
    if (invalid) { setFeedback(invalid); return }
    setSavingId(id)
    setFeedback(null)
    const config = agentConfig(createDraft.name, createDraft.exe, createDraft.args, createDraft.provider, agents.length === 0)
    try {
      await agentClient.ensureConfigRevision()
      await agentClient.createAgent(id, config)
      await refreshAgents()
      setShowCreate(false)
      setConfigConflict(false)
      setCreateDraft({ id: '', name: '', exe: '', provider: 'custom', args: ['acp'] })
      setFeedback(null)
      notify(`已新建 Agent ${id}`)
    } catch (error) {
      // 施工文档 §4.6：embedded source 首次配置——create 撞 config_read_only 时，
      // 自动改为在 exe 旁初始化外部 agents.yaml（同一最小配置）。
      if (wireErrorCode(error) === 'config_read_only') {
        try {
          await agentClient.initializeAgentsConfig(id, agentsDocument(id, config))
          await refreshAgents()
          setShowCreate(false)
          setCreateDraft({ id: '', name: '', exe: '', provider: 'custom', args: ['acp'] })
          setFeedback(`已初始化外部配置并新建 Agent ${id}`)
        } catch (initError) {
          reportConfigMutationError('初始化 Agent 配置', initError, id)
        }
        return
      }
      reportConfigMutationError('新建 Agent', error, id)
    } finally {
      setSavingId(null)
    }
  }

  return (
    <div className="agent-runtime-panel">
      {toast && (
        <div className="agent-runtime-toast" role="status" aria-live="polite">{toast}</div>
      )}
      {feedback && <div className="set-hint" role="status">{feedback}</div>}
      {configConflict && (
        <button type="button" className="set-btn" onClick={() => void reloadConfigSnapshot()}>
          重新载入配置
        </button>
      )}

      {agents.length === 0 && (
        <div className="set-hint" role="status">
          当前没有 Agent 配置。点击“新建 Agent”创建首个外部配置。
        </div>
      )}

      {agents.map(agent => {
        const status = selectAgentStatus(agent.id, activeAgent, agentStatuses)
        const isEditing = editingId === agent.id
        return (
          <div className="agent-runtime-card" key={agent.id}>
            <div className="set-hint" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <strong>{agent.name}</strong>
              <span>{agent.id === activeAgent ? '当前' : ''}{agent.default ? ' · 默认' : ''}</span>
            </div>
            <div className="set-hint">id：{agent.id} · provider：{agent.provider ?? '—'} · transport：{agent.transport ?? 'subprocess'}</div>
            <div className="set-hint">状态：{statusLabel(status.status)} · 配置：{activationLabel(agent.configActivationState)} · exe：{isEditing ? '' : (agent.exe ?? '—')}</div>

            {isEditing && (
              <div className="agent-runtime-edit">
                <input className="set-input" value={draft.name} onChange={event => setDraft({ ...draft, name: event.target.value })} placeholder="name" aria-label="Agent name" />
                <input className="set-input" value={draft.exe} onChange={event => setDraft({ ...draft, exe: event.target.value })} placeholder="exe 绝对路径或命令名" aria-label="Agent exe" />
                <div className="set-hint" role="note">{pathHintForProvider(draft.provider || agent.provider)}</div>
                <div className="set-preset-row">
                  <button className="ps-btn sm" type="button" onClick={() => pickExecutable().then(path => { if (path) setDraft(d => ({ ...d, exe: path })) })}>选择可执行文件</button>
                  <input className="set-input" value={draft.provider} onChange={event => setDraft({ ...draft, provider: event.target.value })} placeholder="provider（可空）" aria-label="Agent provider" />
                </div>
                <ArgumentListEditor args={draft.args} label={agent.id} onChange={args => setDraft({ ...draft, args, argsKnown: true })} />
                <InvocationPreview executable={draft.exe} args={draft.args} effectiveArgs={[...draft.args, ...draft.effectiveSuffix]} />
              </div>
            )}

            {testResult[agent.id] && <div className="set-hint" role="status">{testResult[agent.id]}</div>}

            <div className="set-preset-row">
              {isEditing ? (
                <>
                  <button className="ps-btn sm primary" type="button" disabled={savingId !== null} onClick={() => saveEdit(agent.id)}>{savingId === agent.id ? '保存中…' : '保存'}</button>
                  <button className="ps-btn sm" type="button" disabled={savingId !== null} onClick={() => setEditingId(null)}>取消</button>
                </>
              ) : (
                <button className="ps-btn sm" type="button" disabled={savingId !== null} onClick={() => startEdit(agent)}>编辑</button>
              )}
              <button className="ps-btn sm" type="button" disabled={savingId !== null || agent.default === true} onClick={() => setDefault(agent.id)}>设为默认</button>
              <button className="ps-btn sm" type="button" disabled={testingId !== null} onClick={() => testConnection(agent.id)}>{testingId === agent.id ? '测试中…' : '测试连接'}</button>
              {agent.configActivationState === 'pendingRestart' && (
                <button className="ps-btn sm primary" type="button" disabled={savingId !== null} onClick={() => void restartRuntime(agent.id)}>
                  {savingId === agent.id ? '正在重启…' : '立即重启应用此配置'}
                </button>
              )}
            </div>
          </div>
        )
      })}

      <section className="agent-runtime-discovery" aria-label="发现的运行时">
        <div className="set-preset-row" style={{ marginTop: 12 }}>
          <strong>发现的运行时（{candidates.length}）</strong>
          <button className="ps-btn sm" type="button" disabled={detecting} onClick={() => void detectRuntimes()}>{detecting ? '探测中…' : '重新探测'}</button>
        </div>
        {(detectionElapsedMs > 0 || detectionTruncated) && (
          <div className="set-hint">探测耗时：{detectionElapsedMs}ms{detectionTruncated ? ' · 结果已截断' : ''}</div>
        )}
        {detectionDiagnostics.map((diagnostic, index) => (
          <div className="set-hint" role="status" key={`${diagnostic.code}:${diagnostic.detectorId ?? 'all'}:${index}`}>
            {diagnostic.code}（{diagnostic.stage}）：{diagnostic.message}
          </div>
        ))}
        {detectionCompleted && candidates.length === 0 && (
          <div className="agent-runtime-empty" role="status">
            <span>未发现可自动配置的 ACP Agent。若 Agent 已安装但不在 PATH 中，可以手动选择其可执行文件。</span>
            <button className="ps-btn sm" type="button" onClick={() => setShowCreate(true)}>手动添加</button>
          </div>
        )}
        {candidates.map(candidate => {
          const discoveredDraft = candidateDrafts[candidate.candidateId] ?? candidateDraft(candidate)
          const validation = candidateValidation[candidate.candidateId]
          const importMode = candidateImportMode(candidate, validation)
          const validationDetails = validation ? candidateValidationDetails(validation) : null
          const selected = candidate.candidateId === selectedCandidateId
          return <div className="agent-candidate-option" key={candidate.candidateId}>
          <button type="button" className={`agent-candidate-row ${selected ? 'active' : ''}`} aria-expanded={selected} onClick={() => setSelectedCandidateId(candidate.candidateId)}>
            <span><strong>{candidate.name}</strong><small>{candidate.provider}</small></span>
            <span>{candidate.alreadyImportedAgentId ? `已导入 · ${candidate.alreadyImportedAgentId}` : `${candidate.identityConfidence} · ${candidateStartabilityLabel(candidate.startability)} · ${candidateProtocolLabel(validation)}`}</span>
          </button>
          {selected && <div className="agent-runtime-card">
          <div className="set-hint"><strong>{candidate.name}</strong> · 身份可信度：{candidate.identityConfidence} · 启动：{candidateStartabilityLabel(candidate.startability)} · ACP：{candidateProtocolLabel(validation)} · {candidate.alreadyImportedAgentId ? `已导入为 ${candidate.alreadyImportedAgentId}` : '尚未导入'}</div>
          <div className="agent-runtime-edit">
            <input className="set-input" value={discoveredDraft.id} onChange={event => updateCandidateDraft(candidate, { id: event.target.value })} aria-label={`${candidate.name} Agent id`} />
            <input className="set-input" value={discoveredDraft.name} onChange={event => updateCandidateDraft(candidate, { name: event.target.value })} aria-label={`${candidate.name} Agent name`} />
            <input className="set-input" value={discoveredDraft.executable} onChange={event => updateCandidateDraft(candidate, { executable: event.target.value })} aria-label={`${candidate.name} executable`} />
            <ArgumentListEditor args={discoveredDraft.args} label={candidate.name} onChange={args => updateCandidateDraft(candidate, { args })} />
            <input className="set-input" value={discoveredDraft.provider} onChange={event => updateCandidateDraft(candidate, { provider: event.target.value })} aria-label={`${candidate.name} provider`} />
            <InvocationPreview executable={discoveredDraft.executable} args={discoveredDraft.args} />
          </div>
          {candidate.evidence.map((evidence, index) => <div className="set-hint" key={`${evidence.kind}:${index}`}>{evidence.kind}：{evidence.detail}</div>)}
          {candidate.warnings.map(warning => <div className="set-hint" role="alert" key={warning}>{warning}</div>)}
          <div className="set-preset-row">
            {candidate.alreadyImportedAgentId ? (
              <button className="ps-btn sm primary" type="button" aria-busy={provisioningCandidateId === candidate.candidateId} disabled={provisioningCandidateId !== null} onClick={() => void activateImportedCandidate(candidate)}>{provisioningCandidateId === candidate.candidateId ? '连接中…' : '使用此 Agent'}</button>
            ) : (<>
              <button className="ps-btn sm primary" type="button" aria-busy={provisioningCandidateId === candidate.candidateId} disabled={provisioningCandidateId !== null} onClick={() => void validateAndImportCandidate(candidate)}>{validation?.status === 'testing' ? '验证中…' : provisioningCandidateId === candidate.candidateId ? '正在配置…' : '验证并导入'}</button>
              {importMode === 'unverified' && (
                <button className="ps-btn sm" type="button" disabled={provisioningCandidateId !== null} onClick={() => void importUnverifiedCandidate(candidate)}>仍然导入（未验证）</button>
              )}
            </>)}
            {validation?.status === 'testing' && <span className="set-hint">ACP 验证中，最长 15 秒</span>}
          </div>
          {validationDetails && <div className={`agent-candidate-validation ${validation?.status === 'failed' ? 'failed' : 'ok'}`} role="status">
            <strong>{validationDetails.headline}</strong>
            <span>耗时：{validationDetails.duration} · 阶段：{validationDetails.stage} · 退出码：{validationDetails.exitCode}</span>
            {validationDetails.message && <span>{validationDetails.message}</span>}
            {validation?.status === 'failed' && <pre>stderr：{validationDetails.stderr}</pre>}
            {importMode === 'unverified' && <span>高置信候选可继续导入，导入后标记为未验证。</span>}
            {validation?.status === 'failed' && importMode === 'blocked' && <span>当前置信度必须通过验证后才能导入。</span>}
          </div>}
        </div>}
        </div>})}
      </section>

      <div className="set-preset-row" style={{ marginTop: 12 }}>
        <button className="ps-btn sm" type="button" onClick={() => setShowCreate(value => !value)}>
          {showCreate ? '收起新建' : '新建 Agent'}
        </button>
      </div>

      {showCreate && (
        <div className="agent-runtime-create" aria-label="新建 Agent 配置">
          <input className="set-input" value={createDraft.id} onChange={event => setCreateDraft({ ...createDraft, id: event.target.value })} placeholder="id（字母开头，可含 . _ -）" aria-label="新建 Agent id" />
          <input className="set-input" value={createDraft.name} onChange={event => setCreateDraft({ ...createDraft, name: event.target.value })} placeholder="name" aria-label="新建 Agent name" />
          <input className="set-input" value={createDraft.exe} onChange={event => setCreateDraft({ ...createDraft, exe: event.target.value })} placeholder="exe 绝对路径或命令名" aria-label="新建 Agent exe" />
          <input className="set-input" value={createDraft.provider} onChange={event => setCreateDraft({ ...createDraft, provider: event.target.value })} placeholder="provider" aria-label="新建 Agent provider" />
          <button className="ps-btn sm" type="button" onClick={() => {
            void pickExecutable().then(path => {
              if (!path) return
              const suggested = executableIdentity(path)
              const catalogMatch = builtinAgentCatalog.matchExecutable(path)
              setCreateDraft(current => ({
                ...current,
                exe: path,
                id: current.id || catalogMatch?.provider || suggested.id,
                name: current.name || catalogMatch?.displayName || suggested.name,
                provider: catalogMatch?.provider ?? current.provider,
                args: catalogMatch?.args ?? current.args,
              }))
            })
          }}>选择可执行文件</button>
          <ArgumentListEditor args={createDraft.args} label="新建 Agent" onChange={args => setCreateDraft({ ...createDraft, args })} />
          <InvocationPreview executable={createDraft.exe} args={createDraft.args} />
          <div className="set-hint" role="note">{pathHintForProvider(null)}</div>
          <button className="ps-btn sm primary" type="button" disabled={savingId !== null} onClick={createAgent}>{savingId ? '创建中…' : '创建'}</button>
        </div>
      )}
    </div>
  )
}
