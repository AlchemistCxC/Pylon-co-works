import type { AgentRuntimeCandidate, AgentDetectionDiagnostic, AgentProviderPreflight } from '../../domains/agent/agentDetector.ts'
import { candidateImportMode, candidateValidationDetails, type AgentCandidateValidationState } from '../../domains/agent/candidateValidation.ts'
import { presentDetectionDiagnostic } from './agentDetectionDiagnostics.ts'
import ArgumentListEditor from './ArgumentListEditor.tsx'
import { describeInvocation } from '../../domains/agent/invocationDraft.ts'
import type { CandidateDraft } from './useAgentCandidateProvisioning'

function candidateProtocolLabel(validation: AgentCandidateValidationState | undefined): string {
  if (validation?.status === 'testing') return '验证中'
  if (validation?.status === 'ok') return '可用'
  if (validation?.status === 'failed') return '失败'
  return '未验证'
}

function candidateStartabilityLabel(startability: AgentRuntimeCandidate['startability']): string {
  if (startability === 'verified') return '可启动'
  if (startability === 'failed') return '启动失败'
  return '未探测'
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
 * AgentCandidateList — 「发现的运行时」区（A-V4 拆分自 AgentRuntimePanel，JSX 逐字
 * 随迁）：候选列表（紧凑行 + 展开编辑草稿/证据/警告/验证详情/导入动作）、安装
 * 状态行（A4/C3：cause.summary 优先）、探测诊断文本行与空态入口。
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
  onManualCreate: () => void
  candidateDrafts: Record<string, CandidateDraft>
  candidateValidation: Record<string, AgentCandidateValidationState>
  provisioningCandidateId: string | null
  onValidateAndImport: (candidate: AgentRuntimeCandidate) => void
  onImportUnverified: (candidate: AgentRuntimeCandidate) => void
  onActivateImported: (candidate: AgentRuntimeCandidate) => void
  onUpdateCandidateDraft: (candidate: AgentRuntimeCandidate, patch: Partial<CandidateDraft>) => void
}) {
  const {
    candidates, selectedCandidateId, onSelectCandidate, detectionDiagnostics, detectionElapsedMs,
    detectionPreflight, detectionTruncated, detectionCompleted, detecting, onRedetect, onManualCreate,
    candidateDrafts, candidateValidation, provisioningCandidateId,
    onValidateAndImport, onImportUnverified, onActivateImported, onUpdateCandidateDraft,
  } = props
  return (
    <section className="agent-runtime-discovery" aria-label="发现的运行时">
      <div className="set-preset-row" style={{ marginTop: 12 }}>
        <strong>发现的运行时（{candidates.length}）</strong>
        <button className="ps-btn sm" type="button" disabled={detecting} onClick={onRedetect}>{detecting ? '探测中…' : '重新探测'}</button>
      </div>
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
      {detectionCompleted && candidates.length === 0 && (
        <div className="agent-runtime-empty" role="status">
          <span>未发现可自动配置的 ACP Agent。若 Agent 已安装但不在 PATH 中，可以手动选择其可执行文件。</span>
          <button className="ps-btn sm" type="button" onClick={onManualCreate}>手动添加</button>
        </div>
      )}
      <AgentInstallStatusList preflight={[...detectionPreflight]} />
      {candidates.map(candidate => {
        const discoveredDraft = candidateDrafts[candidate.candidateId] ?? { id: candidate.suggestedAgentId, name: candidate.name, executable: candidate.executable, args: [...candidate.args], provider: candidate.provider }
        const validation = candidateValidation[candidate.candidateId]
        const importMode = candidateImportMode(candidate, validation)
        const validationDetails = validation ? candidateValidationDetails(validation) : null
        const selected = candidate.candidateId === selectedCandidateId
        return <div className="agent-candidate-option" key={candidate.candidateId}>
        <button type="button" className={`agent-candidate-row ${selected ? 'active' : ''}`} aria-expanded={selected} onClick={() => onSelectCandidate(candidate.candidateId)}>
            <span><strong>{candidate.name}</strong><small>{candidate.provider}</small></span>
            <span>{candidate.alreadyImportedAgentId ? `已导入 · ${candidate.alreadyImportedAgentId}` : `${candidate.identityConfidence} · ${candidateStartabilityLabel(candidate.startability)} · ${candidateProtocolLabel(validation)}`}</span>
          </button>
          {selected && <div className="agent-runtime-card">
          <div className="set-hint"><strong>{candidate.name}</strong> · 身份可信度：{candidate.identityConfidence} · 启动：{candidateStartabilityLabel(candidate.startability)} · ACP：{candidateProtocolLabel(validation)} · {candidate.alreadyImportedAgentId ? `已导入为 ${candidate.alreadyImportedAgentId}` : '尚未导入'}</div>
          <div className="agent-runtime-edit">
            <input className="set-input" value={discoveredDraft.id} onChange={event => onUpdateCandidateDraft(candidate, { id: event.target.value })} aria-label={`${candidate.name} Agent id`} />
            <input className="set-input" value={discoveredDraft.name} onChange={event => onUpdateCandidateDraft(candidate, { name: event.target.value })} aria-label={`${candidate.name} Agent name`} />
            <input className="set-input" value={discoveredDraft.executable} onChange={event => onUpdateCandidateDraft(candidate, { executable: event.target.value })} aria-label={`${candidate.name} executable`} />
            <ArgumentListEditor args={discoveredDraft.args} label={candidate.name} onChange={args => onUpdateCandidateDraft(candidate, { args })} />
            <input className="set-input" value={discoveredDraft.provider} onChange={event => onUpdateCandidateDraft(candidate, { provider: event.target.value })} aria-label={`${candidate.name} provider`} />
            <InvocationPreview executable={discoveredDraft.executable} args={discoveredDraft.args} />
          </div>
          {candidate.evidence.map((evidence, index) => <div className="set-hint" key={`${evidence.kind}:${index}`}>{evidence.kind}：{evidence.detail}</div>)}
          {candidate.warnings.map(warning => <div className="set-hint" role="status" key={warning}>{warning}</div>)}
          <div className="set-preset-row">
            {candidate.alreadyImportedAgentId ? (
              <button className="ps-btn sm primary" type="button" aria-busy={provisioningCandidateId === candidate.candidateId} disabled={provisioningCandidateId !== null} onClick={() => onActivateImported(candidate)}>{provisioningCandidateId === candidate.candidateId ? '连接中…' : '使用此 Agent'}</button>
            ) : (<>
              <button className="ps-btn sm primary" type="button" aria-busy={provisioningCandidateId === candidate.candidateId} disabled={provisioningCandidateId !== null} onClick={() => onValidateAndImport(candidate)}>{validation?.status === 'testing' ? '验证中…' : provisioningCandidateId === candidate.candidateId ? '正在配置…' : '验证并导入'}</button>
              {importMode === 'unverified' && (
                <button className="ps-btn sm" type="button" disabled={provisioningCandidateId !== null} onClick={() => onImportUnverified(candidate)}>仍然导入（未验证）</button>
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
  )
}
