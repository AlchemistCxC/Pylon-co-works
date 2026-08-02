import { useMemo, useState } from 'react'
import { useRuntimeStore } from '../../runtimeStore'
import { normalizeConfigOptions } from './configOptionState'
import ConfigOptionField from './ConfigOptionField'
import { invoke } from '@tauri-apps/api/core'
import { reportRuntimeError } from '../../runtimeError'

export default function ConfigOptionsPanel({ sessionSource }: { sessionSource?: string }) {
  const config = useRuntimeStore(state => sessionSource ? state.sessionConfig[sessionSource] : undefined)
  const setSessionConfig = useRuntimeStore(state => state.setSessionConfig)
  const [pending, setPending] = useState<Record<string, boolean>>({})
  const [errors, setErrors] = useState<Record<string, string>>({})
  const options = useMemo(() => normalizeConfigOptions(config?.raw), [config?.raw])
  if (!sessionSource || options.length === 0) return <div className="set-hint">当前会话暂无动态配置选项。</div>

  const update = async (id: string, value: unknown) => {
    const previous = options.find(option => option.id === id)?.currentValue
    // 乐观更新与回滚都基于最新 store 的 raw 打补丁，而非渲染快照：
    // 快速连续更新时旧快照重建会把先成功字段的乐观值覆盖回旧值。
    const patch = (currentValue: unknown) => {
      const raw = useRuntimeStore.getState().sessionConfig[sessionSource]?.raw ?? []
      setSessionConfig(sessionSource, { raw: raw.map(option => option.id === id ? { ...option, currentValue } : option) })
    }
    setPending(state => ({ ...state, [id]: true }))
    setErrors(state => {
      const next = { ...state }
      delete next[id]
      return next
    })
    patch(value)
    try {
      await invoke('set_config_option', { source: sessionSource, key: id, value })
    } catch (error) {
      patch(previous)
      const detail = reportRuntimeError(`更新配置 ${id}`, error)
      setErrors(state => ({ ...state, [id]: detail.message }))
    } finally {
      setPending(state => ({ ...state, [id]: false }))
    }
  }

  return <div className="config-options-panel">
    {options.map(option => <div className="set-row" key={option.id}>
      <span className="set-row-label">{option.label}</span>
      <ConfigOptionField option={option} disabled={pending[option.id] === true} onChange={value => update(option.id, value)} />
      {pending[option.id] && <span className="set-hint" role="status">保存中…</span>}
      {errors[option.id] && <span className="set-hint" role="alert">{errors[option.id]}</span>}
    </div>)}
  </div>
}
