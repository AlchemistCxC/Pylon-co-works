import type { AgentEntry } from '../../domains/identity/identityStore'
import { selectAgentStatus, statusLabel } from '../../contracts/agentTypes'
import { explainErrorCode } from '../../app/errorCodeExplanations.ts'
import type { AgentDetectionDiagnostic } from '../../domains/agent/agentDetector.ts'
import { builtinAgentCatalog } from '../../domains/agent/agentCatalog.ts'
import type { AgentDraftState } from '../../domains/agent/agentDraftMachine.ts'
import ArgumentListEditor from './ArgumentListEditor.tsx'
import InvocationPreview from './InvocationPreview.tsx'
import { pickAgentExecutable } from './pickAgentExecutable.ts'
import type { Draft } from './agentRuntimePanelDrafts'

/** 按 provider 给 exe/命令路径填写引导：文案由 catalog 派生，不在组件内 switch provider（A4）。 */
function pathHintForProvider(provider: string | null | undefined): string {
  return builtinAgentCatalog.executableHint(provider)
}

function activationLabel(state: AgentEntry['configActivationState']): string {
  return state === 'activated' ? '已生效' : state === 'pendingRestart' ? '待重启生效' : '已存储'
}

/**
 * AgentRuntimeCard — 单张 Agent 运行时卡（A-V4 拆分自 AgentRuntimePanel，JSX 逐字
 * 随迁）：身份行/状态行/探测失败归因（#325）/运行期错误/编辑表单（草稿 + 启动计划）/
 * 动作排（保存/先测试连接/取消验证/取消/编辑/设默认/测试连接/重启/删除）。
 * 状态与事务仍在面板（编辑流跨卡单飞），本组件纯呈现 + 回调。
 */
export default function AgentRuntimeCard(props: {
  agent: AgentEntry
  activeAgent: string
  status: ReturnType<typeof selectAgentStatus>
  isEditing: boolean
  draft: Draft
  onPatchDraft: (updater: (current: Draft) => Draft) => void
  draftLaunchPlan: { argv: string[] } | null
  draftMachinePhase: AgentDraftState['phase']
  probeFailure: AgentDetectionDiagnostic | undefined
  detecting: boolean
  onRedetect: () => void
  savingId: string | null
  testingId: string | null
  testResultText: string | undefined
  onStartEdit: () => void
  onSaveEdit: () => void
  onTestDraftConnection: () => void
  onCancelDraftTest: () => void
  onCancelEdit: () => void
  onSetDefault: () => void
  onTestConnection: () => void
  onRestartRuntime: () => void
  onDeleteAgent: () => void
}) {
  const { agent, activeAgent, status, isEditing, draft, onPatchDraft, draftLaunchPlan, draftMachinePhase, probeFailure, detecting, onRedetect, savingId, testingId, testResultText } = props
  return (
    <div className="agent-runtime-card">
      <div className="set-hint" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <strong>{agent.name}</strong>
        <span>{agent.id === activeAgent ? '当前' : ''}{agent.default ? ' · 默认' : ''}</span>
      </div>
      <div className="set-hint">id：{agent.id} · provider：{agent.provider ?? '—'} · transport：{agent.transport ?? 'subprocess'}</div>
      <div className="set-hint">状态：{statusLabel(status.status)} · 配置：{activationLabel(agent.configActivationState)} · exe：{isEditing ? '' : (agent.exe ?? '—')}</div>
      {/* #325：探测失败的原因必须落到**这张卡**上——此前只有「未激活」，
          真实原因（version_probe_spawn_failed os error 193 等）只进控制台。
          归因走结构化字段：诊断带 candidateId，候选带 alreadyImportedAgentId。 */}
      {probeFailure && status.status !== 'connected' && (
        <div className="set-hint agent-runtime-failure" role="status">
          探测失败：<code>{probeFailure.code}</code>
          <span> {explainErrorCode(probeFailure.code)?.summary ?? '原因见运行日志'}</span>
          {/* 归因可能来自同 provider 的另一个可执行形式：把被测路径写出来，用户才
              知道失败的不是卡片上那个 exe。 */}
          {probeFailure.executable && <span className="agent-runtime-failure-path">{probeFailure.executable}</span>}
          <button className="ps-btn sm" type="button" disabled={detecting} onClick={onRedetect}>
            {detecting ? '探测中…' : '重试探测'}
          </button>
        </div>
      )}
      {/* 与探测失败各自独立：探测失败是「能不能启动」的事实，recentError 是运行期事实，
          两者可以同时成立，不能互相顶掉。 */}
      {status.recentError && (
        <div className="set-hint agent-runtime-failure" role="status">最近错误：{status.recentError}</div>
      )}

      {isEditing && (
        <div className="agent-runtime-edit">
          <input className="set-input" value={draft.name} onChange={event => onPatchDraft(d => ({ ...d, name: event.target.value }))} placeholder="name" aria-label="Agent name" />
          <input className="set-input" value={draft.exe} onChange={event => onPatchDraft(d => ({ ...d, exe: event.target.value }))} placeholder="exe 绝对路径或命令名" aria-label="Agent exe" />
          <div className="set-hint" role="note">{pathHintForProvider(draft.provider || agent.provider)}</div>
          <div className="set-preset-row">
            <button className="ps-btn sm" type="button" onClick={() => pickAgentExecutable().then(path => { if (path) onPatchDraft(d => ({ ...d, exe: path })) })}>选择可执行文件</button>
            <input className="set-input" value={draft.provider} onChange={event => onPatchDraft(d => ({ ...d, provider: event.target.value }))} placeholder="provider（可空）" aria-label="Agent provider" />
          </div>
          <ArgumentListEditor args={draft.args} label={agent.id} onChange={args => onPatchDraft(d => ({ ...d, args, argsKnown: true }))} />
          <InvocationPreview executable={draft.exe} args={draft.args} effectiveArgs={[...draft.args, ...draft.effectiveSuffix]} />
        </div>
      )}

      {testResultText && <div className="set-hint" role="status">{testResultText}</div>}
      {isEditing && draftLaunchPlan?.argv && (
        <div className="set-hint" role="note">{`启动计划：${draftLaunchPlan.argv.join(' ')}（env 值已隐藏）`}</div>
      )}

      <div className="set-preset-row">
        {isEditing ? (
          <>
            <button className="ps-btn sm primary" type="button" disabled={savingId !== null || draftMachinePhase === 'testing'} onClick={props.onSaveEdit}>{savingId === agent.id ? '保存中…' : '保存'}</button>
            <button className="ps-btn sm" type="button" disabled={testingId !== null || savingId !== null} onClick={props.onTestDraftConnection}>{testingId === agent.id ? '测试中…' : '先测试连接'}</button>
            {draftMachinePhase === 'testing' && (
              <button className="ps-btn sm" type="button" onClick={props.onCancelDraftTest}>取消验证</button>
            )}
            <button className="ps-btn sm" type="button" disabled={savingId !== null || draftMachinePhase === 'testing'} onClick={props.onCancelEdit}>取消</button>
          </>
        ) : (
          <button className="ps-btn sm" type="button" disabled={savingId !== null} onClick={props.onStartEdit}>编辑</button>
        )}
        <button className="ps-btn sm" type="button" disabled={savingId !== null || agent.default === true} onClick={props.onSetDefault}>设为默认</button>
        <button className="ps-btn sm" type="button" disabled={testingId !== null} onClick={props.onTestConnection}>{testingId === agent.id ? '测试中…' : '测试连接'}</button>
        {agent.configActivationState === 'pendingRestart' && (
          <button className="ps-btn sm primary" type="button" disabled={savingId !== null} onClick={props.onRestartRuntime}>
            {savingId === agent.id ? '正在重启…' : '立即重启应用此配置'}
          </button>
        )}
        {/* issue #67A：删除入口。active agent 禁用（禁用按钮不弹 tooltip，故用内联说明）。 */}
        <button
          className="ps-btn sm"
          type="button"
          disabled={savingId !== null || testingId !== null || agent.id === activeAgent}
          onClick={props.onDeleteAgent}
        >
          {savingId === agent.id ? '删除中…' : '删除'}
        </button>
        {agent.id === activeAgent && (
          <span className="set-hint" role="note">当前正在使用的 Agent 不能删除，请先切换到其它 Agent</span>
        )}
      </div>
    </div>
  )
}
