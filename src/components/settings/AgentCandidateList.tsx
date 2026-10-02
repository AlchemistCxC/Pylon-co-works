import type { AgentRuntimeCandidate, AgentDetectionDiagnostic, AgentProviderPreflight } from '../../domains/agent/agentDetector.ts'
import { candidateImportMode, candidateValidationDetails, type AgentCandidateValidationState } from '../../domains/agent/candidateValidation.ts'
import { presentDetectionDiagnostic } from './agentDetectionDiagnostics.ts'
import ArgumentListEditor from './ArgumentListEditor.tsx'
import { describeInvocation } from '../../domains/agent/invocationDraft.ts'
import type { CandidateDraft } from './useAgentCandidateProvisioning'

const actionBase = 'inline-flex min-h-8 items-center justify-center rounded-sm border px-3 py-1 font-sans text-sm transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring disabled:cursor-default disabled:opacity-50'
const actionButton = `${actionBase} border-stroke-default bg-surface-raised text-content-text hover:bg-hover-bg`
const primaryButton = `${actionBase} border-accent-edge bg-accent-soft text-content-text font-semibold hover:bg-accent-soft-strong`
const draftInput = 'w-full min-w-0 rounded-sm border border-stroke-default bg-surface-panel px-2 py-1 font-sans text-sm text-content-text focus-visible:outline-2 focus-visible:outline-focus-ring disabled:opacity-50'

function candidateProtocolLabel(validation: AgentCandidateValidationState | undefined): string {
  if (validation?.status === 'testing') return '验证中'
  if (validation?.status === 'ok') return '可用'
  if (validation?.status === 'failed') return '失败'
  return '未验证'
}

function candidateStartabilityLabel(startability: AgentRuntimeCandidate['startability']): string {
  if (startability === 'verified') return '可启动'
  if (startability === 'failed') return '启动失败'
  return '版本未确认'
}

function InvocationPreview({ executable, args }: { executable: string; args: string[] }) {
  const invocation = describeInvocation({ executable, args })
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

function AgentInstallStatusList({ preflight }: { preflight: readonly AgentProviderPreflight[] }) {
  if (preflight.length === 0) return null
  return <div className="agent-install-status" aria-label="本机 Agent 安装状态">
    {preflight.map(entry => {
      const cause = entry.cause
      const reason = cause
        ? (cause.level === 'ok' ? '' : cause.summary)
        : agentInstallStatusReason(entry.status)
      const adapter = entry.adapter
      return <div key={entry.provider} className={`agent-install-row ${installStatusClass(entry.status)}`} role="status">
        <span><strong>{entry.provider}</strong><small>{agentInstallStatusLabel(entry.status)}</small></span>
        {reason && <span>{reason}</span>}
        {adapter && <span className="set-hint">
          {`ACP：${adapter.acpPresent ? '已找到' : '未找到'} · ${adapter.nativeLabel}（${adapter.nativeCmd}）：${adapter.nativePresent ? '已找到' : '未找到'} · 共享配置目录 ${adapter.sharedConfigDir}：${adapter.sharedConfigPresent ? '存在' : '不存在'}`}
        </span>}
        {entry.checks.filter(check => check.status !== 'PASS').map(check => (
          <span className="set-hint" key={check.checkId} role="status">{`${check.label}：${check.message}（${check.status}）`}</span>
        ))}
      </div>
    })}
  </div>
}

import {
  agentInstallStatusLabel,
  agentInstallStatusReason,
} from '../../domains/agent/agentDetector.ts'

function installStatusClass(status: AgentProviderPreflight['status']): string {
  if (status === 'installed') return 'ok'
  if (status === 'versionTooOld' || status === 'adapterMissing') return 'failed'
  return 'warn'
}

/**
 * 设置页发现入口：优先展示候选与导入动作，报告、草稿和诊断按需展开。
 * 状态与副作用由宿主提供，此组件只呈现状态并转发操作。
 */
export default function AgentCandidateList(props: {
  candidates: readonly AgentRuntimeCandidate[]
  selectedCandidateId: string | null
  onSelectCandidate: (candidateId: string) => void
  detectionDiagnostics: readonly AgentDetectionDiagnostic[]
  detectionElapsedMs: number
  detectionPreflight: readonly AgentProviderPreflight[]
  detectionTruncated: boolean
  detectionCompleted: boolean
  detecting: boolean
  onRedetect: () => void
  onCancelDetection: () => void
  onManualCreate: () => void
  candidateDrafts: Record<string, CandidateDraft>
  candidateValidation: Record<string, AgentCandidateValidationState>
  importedCandidateIds: Record<string, string>
  candidateErrors: Record<string, string>
  provisioningCandidateId: string | null
  provisioningPhase: 'testing' | 'saving' | 'activating' | null
  onCancelValidation: () => void
  onValidateAndImport: (candidate: AgentRuntimeCandidate) => void
  onImportUnverified: (candidate: AgentRuntimeCandidate) => void
  onActivateImported: (candidate: AgentRuntimeCandidate) => void
  onUpdateCandidateDraft: (candidate: AgentRuntimeCandidate, patch: Partial<CandidateDraft>) => void
}) {
  const {
    candidates, selectedCandidateId, onSelectCandidate, detectionDiagnostics, detectionElapsedMs,
    detectionPreflight, detectionTruncated, detectionCompleted, detecting, onRedetect, onCancelDetection, onManualCreate,
    candidateDrafts, candidateValidation, importedCandidateIds, candidateErrors, provisioningCandidateId, provisioningPhase, onCancelValidation,
    onValidateAndImport, onImportUnverified, onActivateImported, onUpdateCandidateDraft,
  } = props
  return (
    <section className="agent-runtime-discovery" aria-label="发现的运行时">
      <div className="set-preset-row mt-3">
        <strong>发现的运行时（{candidates.length}）</strong>
        <button className={actionButton} type="button" disabled={detecting || provisioningCandidateId !== null} onClick={onRedetect}>{detecting ? '探测中…' : '重新探测'}</button>
        {detecting && <button className={actionButton} type="button" onClick={onCancelDetection}>取消探测</button>}
        <button className={actionButton} type="button" disabled={provisioningCandidateId !== null} onClick={onManualCreate}>手动添加</button>
      </div>
      <p className="set-hint">选择启动入口后验证并导入。导入会保存配置，点击“使用此 Agent”再连接并打开工作区。</p>
      {detecting && <div className="set-hint" role="status">正在检查本机的 ACP 启动入口…</div>}
      {detectionCompleted && candidates.length === 0 && <div className="agent-runtime-empty" role="status">
        未发现可自动配置的 ACP Agent。若 Agent 已安装但不在 PATH 中，可以手动选择其可执行文件。
      </div>}
      <details className="my-2">
        <summary className="cursor-pointer text-sm text-muted">探测报告与安装状态{detectionDiagnostics.length > 0 ? `（${detectionDiagnostics.length} 条提示）` : ''}</summary>
      {(detectionElapsedMs > 0 || detectionTruncated) && (
        <div className="set-hint">探测耗时：{detectionElapsedMs}ms{detectionTruncated ? ' · 结果已截断' : ''}</div>
      )}
      {detectionDiagnostics.map((diagnostic, index) => {
        // #116 子项 10：UI 只呈现「哪条探测 · 哪个候选 · 本地化原因」；
        // 内部码与系统级原文由 presentDetectionDiagnostic 的 raw 进运行日志。
        const presented = presentDetectionDiagnostic(diagnostic)
        return (
          <div className="set-hint" role="status" key={`${diagnostic.code}:${diagnostic.detectorId ?? 'all'}:${index}`}>
            {presented.text}
          </div>
        )
      })}
      <AgentInstallStatusList preflight={[...detectionPreflight]} />
      </details>
      {candidates.map(candidate => {
        const discoveredDraft = candidateDrafts[candidate.candidateId] ?? { id: candidate.suggestedAgentId, name: candidate.name, executable: candidate.executable, args: [...candidate.args], provider: candidate.provider }
        const validation = candidateValidation[candidate.candidateId]
        const importMode = candidateImportMode(candidate, validation)
        const validationDetails = validation ? candidateValidationDetails(validation) : null
        const selected = candidate.candidateId === selectedCandidateId
        const importedId = importedCandidateIds[candidate.candidateId] ?? candidate.alreadyImportedAgentId
        const busy = provisioningCandidateId === candidate.candidateId
        const alternatives = [{ candidateId: candidate.candidateId, executable: candidate.executable, args: candidate.args, startability: candidate.startability }, ...(candidate.alternatives ?? [])]
        const invocation = alternatives.find(entry => entry.executable === discoveredDraft.executable && JSON.stringify(entry.args) === JSON.stringify(discoveredDraft.args))
        const readiness = validation?.status === 'ok' ? '连接验证通过' : candidateStartabilityLabel(invocation?.startability)
        return <div className="agent-candidate-option" key={candidate.candidateId}>
        <button type="button" className={`agent-candidate-row ${selected ? 'active' : ''}`} disabled={provisioningCandidateId !== null && !busy} aria-expanded={selected} onClick={() => onSelectCandidate(candidate.candidateId)}>
            <span><strong>{candidate.name}</strong><small>{candidate.provider}</small></span>
            <span>{importedId ? `已导入 · ${importedId}` : `${readiness} · ${candidateProtocolLabel(validation)}`}</span>
          </button>
          {selected && <div className="agent-runtime-card">
          <div className="set-hint"><strong>{candidate.name}</strong> · ACP：{candidateProtocolLabel(validation)} · {importedId ? `已导入为 ${importedId}` : '尚未导入'}</div>
          {!importedId && alternatives.length > 1 && <label className="flex flex-col gap-1 text-sm">
            启动入口
            <select className={draftInput} aria-label={`${candidate.name} 启动入口`} disabled={provisioningCandidateId !== null} value={invocation?.candidateId ?? ''} onChange={event => {
              const entry = alternatives.find(item => item.candidateId === event.target.value)
              if (entry) onUpdateCandidateDraft(candidate, { executable: entry.executable, args: [...entry.args] })
            }}>
              {!invocation && <option value="">自定义启动入口</option>}
              {alternatives.map(entry => <option key={entry.candidateId} value={entry.candidateId}>{describeInvocation(entry).display}</option>)}
            </select>
          </label>}
          <InvocationPreview executable={discoveredDraft.executable} args={discoveredDraft.args} />
          {!importedId && <details className="my-2">
          <summary className="cursor-pointer text-sm text-muted">调整导入配置</summary>
          <fieldset className="m-0 min-w-0 border-0 p-0" disabled={busy && provisioningPhase === 'saving'}>
          <div className="agent-runtime-edit">
            <label>标识<input className={draftInput} value={discoveredDraft.id} onChange={event => onUpdateCandidateDraft(candidate, { id: event.target.value })} aria-label={`${candidate.name} Agent id`} /></label>
            <label>名称<input className={draftInput} value={discoveredDraft.name} onChange={event => onUpdateCandidateDraft(candidate, { name: event.target.value })} aria-label={`${candidate.name} Agent name`} /></label>
            <label>可执行文件<input className={draftInput} value={discoveredDraft.executable} onChange={event => onUpdateCandidateDraft(candidate, { executable: event.target.value })} aria-label={`${candidate.name} executable`} /></label>
            <ArgumentListEditor args={discoveredDraft.args} label={candidate.name} onChange={args => onUpdateCandidateDraft(candidate, { args })} />
            <label>提供方<input className={draftInput} value={discoveredDraft.provider} onChange={event => onUpdateCandidateDraft(candidate, { provider: event.target.value })} aria-label={`${candidate.name} provider`} /></label>
          </div>
          </fieldset>
          </details>}
          <details className="my-2">
          <summary className="cursor-pointer text-sm text-muted">发现依据与其他入口（{candidate.evidence.length}）</summary>
          {candidate.evidence.map((evidence, index) => <div className="set-hint" key={`${evidence.kind}:${index}`}>{evidence.kind}：{evidence.detail}</div>)}
          {candidate.warnings.map(warning => <div className="set-hint" role="status" key={warning}>{warning}</div>)}
          </details>
          {candidateErrors[candidate.candidateId] && <div className="set-hint" role="alert">{candidateErrors[candidate.candidateId]}</div>}
          <div className="set-preset-row">
            {importedId ? (
              <button className={primaryButton} type="button" aria-busy={busy} disabled={provisioningCandidateId !== null} onClick={() => onActivateImported(candidate)}>{busy ? provisioningPhase === 'activating' ? '连接中…' : '刷新配置中…' : '使用此 Agent'}</button>
            ) : (<>
              <button className={primaryButton} type="button" aria-busy={busy} disabled={provisioningCandidateId !== null} onClick={() => onValidateAndImport(candidate)}>{busy ? provisioningPhase === 'saving' ? '保存配置中…' : '验证连接中…' : validation?.status === 'ok' ? '导入已验证配置' : validation?.status === 'failed' ? '重新验证并导入' : '验证并导入'}</button>
              {importMode === 'unverified' && (
                <button className={actionButton} type="button" disabled={provisioningCandidateId !== null} onClick={() => onImportUnverified(candidate)}>仍然导入（未验证）</button>
              )}
            </>)}
            {busy && provisioningPhase === 'testing' && <>
              <button className={actionButton} type="button" onClick={onCancelValidation}>取消验证</button>
              <span className="set-hint">正在验证连接，最长 15 秒</span>
            </>}
          </div>
          {validationDetails && <div className={`agent-candidate-validation ${validation?.status === 'failed' ? 'failed' : 'ok'}`} role="status">
            <strong>{validationDetails.headline}</strong>
            <span>耗时：{validationDetails.duration}{validation?.status === 'failed' ? ` · 阶段：${validationDetails.stage}` : ''}</span>
            {validationDetails.message && <span>{validationDetails.message}</span>}
            {validation?.status === 'failed' && <details><summary className="cursor-pointer">错误详情</summary><span>退出码：{validationDetails.exitCode}</span><pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words">stderr：{validationDetails.stderr}</pre></details>}
            {importMode === 'unverified' && <span>高置信候选可继续导入，导入后标记为未验证。</span>}
            {validation?.status === 'failed' && importMode === 'blocked' && <span>当前置信度必须通过验证后才能导入。</span>}
          </div>}
        </div>}
        </div>})}
    </section>
  )
}
