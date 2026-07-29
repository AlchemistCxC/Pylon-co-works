import { useMemo, useState } from 'react'
import { useStore } from '../../store'
import { normalizeConfigOptions } from './configOptionState'
import ConfigOptionField from './ConfigOptionField'
import { invoke } from '@tauri-apps/api/core'
import { reportRuntimeError } from '../../runtimeError'

export default function ConfigOptionsPanel({ sessionSource }: { sessionSource?: string }) {
  const config = useStore(state => sessionSource ? state.sessionConfig[sessionSource] : undefined)
  const setSessionConfig = useStore(state => state.setSessionConfig)
  const [pending, setPending] = useState<string | null>(null)
  const options = useMemo(() => normalizeConfigOptions(config?.raw), [config?.raw])
  if (!sessionSource || options.length === 0) return <div className="set-hint">当前会话暂无动态配置选项。</div>

  const update = async (id: string, value: unknown) => {
    const previous = options.find(option => option.id === id)?.currentValue
    setPending(id)
    setSessionConfig(sessionSource, { raw: options.map(option => option.id === id ? { ...option.raw, currentValue: value } : option.raw) })
    try {
      await invoke('set_config_option', { source: sessionSource, key: id, value })
    } catch (error) {
      setSessionConfig(sessionSource, { raw: options.map(option => option.id === id ? { ...option.raw, currentValue: previous } : option.raw) })
      reportRuntimeError(`更新配置 ${id}`, error)
    } finally { setPending(null) }
  }

  return <div className="config-options-panel">
    {options.map(option => <div className="set-row" key={option.id}>
      <span className="set-row-label">{option.label}</span>
      <ConfigOptionField option={option} disabled={pending !== null} onChange={value => update(option.id, value)} />
    </div>)}
  </div>
}
