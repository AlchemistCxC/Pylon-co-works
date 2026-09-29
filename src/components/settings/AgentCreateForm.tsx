import { useState } from 'react'
import { builtinAgentCatalog } from '../../domains/agent/agentCatalog.ts'
import ArgumentListEditor from './ArgumentListEditor.tsx'
import InvocationPreview from './InvocationPreview.tsx'
import { pickAgentExecutable } from './pickAgentExecutable.ts'

/** 按 provider 给 exe/命令路径填写引导：文案由 catalog 派生，不在组件内 switch provider（A4）。 */
function pathHintForProvider(provider: string | null | undefined): string {
  return builtinAgentCatalog.executableHint(provider)
}

function executableIdentity(path: string): { id: string; name: string } {
  const fileName = path.trim().split(/[\\/]/).pop()?.replace(/\.(?:exe|cmd|bat)$/i, '').trim() ?? ''
  const id = fileName
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '') || 'agent'
  return { id, name: fileName || 'Agent' }
}

export interface AgentCreateDraftInput {
  id: string
  name: string
  exe: string
  provider: string
  args: string[]
}

const EMPTY_CREATE_DRAFT: AgentCreateDraftInput = { id: '', name: '', exe: '', provider: 'custom', args: ['acp'] }

/**
 * AgentCreateForm — 新建 Agent 表单（A-V4 拆分自 AgentRuntimePanel，JSX 逐字随迁）。
 * 草稿自持（随开合重置——与原「成功后清空」等价）；提交经 onCreate 走面板侧事务
 * （校验/CAS/嵌入式降级在面板，成功后面板收起表单即重置草稿）。
 */
export default function AgentCreateForm({ busy, onCreate }: {
  busy: boolean
  onCreate: (draft: AgentCreateDraftInput) => Promise<void>
}) {
  const [createDraft, setCreateDraft] = useState<AgentCreateDraftInput>(EMPTY_CREATE_DRAFT)
  return (
    <div className="agent-runtime-create" aria-label="新建 Agent 配置">
      <input className="set-input" value={createDraft.id} onChange={event => setCreateDraft({ ...createDraft, id: event.target.value })} placeholder="id（字母开头，可含 . _ -）" aria-label="新建 Agent id" />
      <input className="set-input" value={createDraft.name} onChange={event => setCreateDraft({ ...createDraft, name: event.target.value })} placeholder="name" aria-label="新建 Agent name" />
      <input className="set-input" value={createDraft.exe} onChange={event => setCreateDraft({ ...createDraft, exe: event.target.value })} placeholder="exe 绝对路径或命令名" aria-label="新建 Agent exe" />
      <input className="set-input" value={createDraft.provider} onChange={event => setCreateDraft({ ...createDraft, provider: event.target.value })} placeholder="provider" aria-label="新建 Agent provider" />
      <button className="ps-btn sm" type="button" onClick={() => {
        void pickAgentExecutable().then(path => {
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
      <button className="ps-btn sm primary" type="button" disabled={busy} onClick={() => { void onCreate(createDraft) }}>{busy ? '创建中…' : '创建'}</button>
    </div>
  )
}
