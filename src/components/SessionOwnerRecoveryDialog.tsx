import { useEffect, useMemo, useState } from 'react'
import { useIdentityStore } from '../identityStore'
import { resolveUnresolvedSessionTransaction } from '../app/bootstrap/resolveUnresolvedSessionTransaction'
import type { LegacySession } from '../sessionPersistence'
import Select from './ui/Select.tsx'

/**
 * ISSUE-01：未决 Session 恢复入口。
 *
 * 取消只隐藏当前提示，不写回、不丢弃原始 envelope；store 发生变化后重新出现。
 */
export default function SessionOwnerRecoveryDialog() {
  const hydration = useIdentityStore(s => s.sessionHydration)
  const agents = useIdentityStore(s => s.agents)
  const hydrationUnresolved = hydration?.kind === 'needs-owner-resolution' ? hydration.unresolved : null
  const [dismissed, setDismissed] = useState(false)
  const [selected, setSelected] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const unresolved: readonly LegacySession[] = useMemo(() => hydrationUnresolved ?? [], [hydrationUnresolved])
  const unresolvedKey = unresolved.map(session => session.id).join('\u0000')

  useEffect(() => {
    setDismissed(false)
  }, [unresolvedKey])

  useEffect(() => {
    if (unresolved.length === 0) {
      setDismissed(false)
      return
    }
    setSelected(current => {
      const next = { ...current }
      for (const session of unresolved) if (!next[session.id] && agents[0]) next[session.id] = agents[0].id
      return next
    })
  }, [agents, unresolved])

  if (unresolved.length === 0 || dismissed) return null

  const resolve = async (sessionId: string) => {
    const agentId = selected[sessionId]
    if (!agentId) return
    setBusy(sessionId)
    setError(null)
    const result = await resolveUnresolvedSessionTransaction(sessionId, agentId, {
      getUnresolved: () => {
        const current = useIdentityStore.getState().sessionHydration
        return current?.kind === 'needs-owner-resolution' ? current.unresolved : []
      },
      getAgents: () => useIdentityStore.getState().agents,
      commit: async (session, owner) => {
        const ok = await useIdentityStore.getState().resolveSessionOwner(session.id, owner)
        if (!ok) throw new Error('保存会话归属失败')
      },
    })
    setBusy(null)
    if (!result.ok) setError(result.message)
  }

  return (
    <div className="session-owner-dialog-overlay" role="dialog" aria-modal="true" aria-label="恢复遗留会话归属">
      <div className="session-owner-dialog">
        <h2>恢复遗留会话归属</h2>
        <p>以下会话无法从持久化数据唯一判断所属 Agent。请选择后确认；稍后处理不会修改原始数据。</p>
        <ul>
          {unresolved.map(session => (
            <li key={session.id}>
              <span>{session.name}</span>
              <div className="session-owner-select">
                <Select
                  ariaLabel={`${session.name}的 Agent`}
                  value={selected[session.id] ?? ''}
                  disabled={busy === session.id}
                  onChange={agentId => setSelected(current => ({ ...current, [session.id]: agentId }))}
                  options={agents.map(agent => ({ value: agent.id, label: agent.name }))}
                />
              </div>
              <button type="button" disabled={busy === session.id || !selected[session.id]} onClick={() => void resolve(session.id)}>
                {busy === session.id ? '保存中…' : '确认恢复'}
              </button>
            </li>
          ))}
        </ul>
        {error && <p role="alert">{error}</p>}
        <button type="button" onClick={() => setDismissed(true)}>稍后处理</button>
      </div>
    </div>
  )
}
