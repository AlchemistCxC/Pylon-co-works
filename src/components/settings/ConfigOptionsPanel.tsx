import { useMemo, useRef, useState } from 'react'
import { useRuntimeStore } from '../../runtimeStore'
import { normalizeConfigOptions } from './configOptionState'
import ConfigOptionField from './ConfigOptionField'
import { invoke } from '@tauri-apps/api/core'
import { createChatClient } from '../../infrastructure/acp/chatClient'
import { reportRuntimeError, resolveRuntimeErrors } from '../../runtimeError.ts'
import type { AgentContext } from '../../agentContext'
import { toAgentContextKey } from '../../agentContext'

export default function ConfigOptionsPanel({ context }: { context?: AgentContext }) {
  const config = useRuntimeStore(state => context ? state.sessionConfig[toAgentContextKey(context)] : undefined)
  const setSessionConfig = useRuntimeStore(state => state.setSessionConfig)
  const [pending, setPending] = useState<Record<string, boolean>>({})
  const [errors, setErrors] = useState<Record<string, string>>({})
  // 每 option 的请求序列号：仅最新请求可回滚/报错/清 pending——
  // 旧请求失败时其值已被更新的在途请求取代，回滚会把成功提交的新值覆盖回旧值。
  const latestReqRef = useRef<Record<string, number>>({})
  const options = useMemo(() => normalizeConfigOptions(config?.raw), [config?.raw])
  if (!context || options.length === 0) return <div className="set-hint">当前会话暂无动态配置选项。</div>

  const update = async (id: string, value: unknown) => {
    const seq = (latestReqRef.current[id] ?? 0) + 1
    latestReqRef.current[id] = seq
    const previous = options.find(option => option.id === id)?.currentValue
    // 乐观更新与回滚都基于最新 store 的 raw 打补丁，而非渲染快照：
    // 快速连续更新时旧快照重建会把先成功字段的乐观值覆盖回旧值。
    const patch = (currentValue: unknown) => {
      const raw = useRuntimeStore.getState().sessionConfig[toAgentContextKey(context)]?.raw ?? []
      setSessionConfig(context, { raw: raw.map(option => option.id === id ? { ...option, currentValue } : option) })
    }
    setPending(state => ({ ...state, [id]: true }))
    setErrors(state => {
      const next = { ...state }
      delete next[id]
      return next
    })
    patch(value)
    try {
      await createChatClient({ invoke: (cmd, args) => invoke(cmd, args as Record<string, unknown> | undefined) }).setConfigOption({ agentId: context.agentId, source: context.source, key: id, value })
      resolveRuntimeErrors({ key: `session-config:${toAgentContextKey(context)}:${id}` })
    } catch (error) {
      if (latestReqRef.current[id] !== seq) return
      patch(previous)
      reportRuntimeError(`更新配置 ${id}`, error, context.agentId, {
        key: `session-config:${toAgentContextKey(context)}:${id}`,
        scope: { kind: 'operation', id: `session-config:${toAgentContextKey(context)}:${id}` },
        source: 'chat.config-option',
        recovery: { kind: 'open-runtime-log', sessionId: context.source },
      })
      setErrors(state => ({ ...state, [id]: '保存失败，详情见右下角错误中心' }))
    } finally {
      if (latestReqRef.current[id] === seq) setPending(state => ({ ...state, [id]: false }))
    }
  }

  return <div className="config-options-panel">
    {options.map(option => <div className="set-row" key={option.id}>
      <span className="set-row-label">{option.label}</span>
      <ConfigOptionField option={option} disabled={pending[option.id] === true} onChange={value => update(option.id, value)} />
      {pending[option.id] && <span className="set-hint" role="status">保存中…</span>}
      {errors[option.id] && <span className="set-hint" role="status">{errors[option.id]}（详情见右下角错误中心）</span>}
    </div>)}
  </div>
}
