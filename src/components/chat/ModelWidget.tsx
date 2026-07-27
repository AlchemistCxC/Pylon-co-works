import { useStore } from '../../store'
import { invoke } from '@tauri-apps/api/core'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'

// 无后端 session 时的降级列表（预览/未连接）
const FALLBACK_MODELS = ['deepseek-v4-flash', 'deepseek-v4-pro']

/**
 * modelVariant 取值：
 *   - 'dropdown'  : 默认下拉菜单（点击展开）
 *   - 'minimal'   : 单行 inline，点击循环切下一个（省空间）
 *   - 'badge'     : 圆角徽章样式（只读展示）
 *
 * 切换模型走后端 set_config_option({ source, key:'model', value })，
 * 模型列表 & 当前值优先取后端 sessionConfig；无 session 时降级到本地列表。
 */
interface Props { sessionSource?: string }

export default function ModelWidget({ sessionSource }: Props) {
  const variant = useStore(s => s.modelVariant) || 'dropdown'
  const ccScale = useStore(s => (s.ccScale || {})['model'] ?? 100)
  const cfg = useStore(s => (sessionSource ? s.sessionConfig[sessionSource] : undefined))
  // 降级：无后端配置时读 profile.model（历史行为）
  const activeProfile = useStore(s => s.profiles.find(x => x.id === s.activeProfileId))

  const models = (cfg?.models && cfg.models.length ? cfg.models : FALLBACK_MODELS)
  const model = cfg?.model || activeProfile?.model || models[0]

  const setModel = (m: string) => {
    if (m === model) return
    if (sessionSource) {
      // 主路径：通知后端 + 乐观更新本地 sessionConfig
      useStore.getState().setSessionConfig(sessionSource, { model: m })
      invoke('set_config_option', { source: sessionSource, key: 'model', value: m }).catch(() => {
        // 失败回滚
        useStore.getState().setSessionConfig(sessionSource, { model })
      })
    } else {
      // 降级：无 session（预览等），只改 profile
      const profile = useStore.getState().profiles.find(x => x.id === useStore.getState().activeProfileId)
      if (profile) useStore.getState().addProfile({ ...profile, model: m })
    }
  }

  if (variant === 'minimal') {
    const idx = models.indexOf(model)
    const next = models[(idx + 1) % models.length]
    return (
      <button className="cc-model-minimal" type="button" onClick={() => setModel(next)} title="点击切换模型"
        style={{ fontSize: `${ccScale}%` }}>
        {model}
      </button>
    )
  }

  if (variant === 'badge') {
    return (
      <span className="cc-model-badge" style={{ fontSize: `${ccScale}%` }}>{model}</span>
    )
  }

  // default: 'dropdown'
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger className="model-tag" style={{ fontSize: `${ccScale}%` }}>{model} ▾</DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="model-menu" sideOffset={4}>
          {models.map(m => (
            <DropdownMenu.Item key={m} className={`model-item ${m === model ? 'active' : ''}`}
              onClick={() => setModel(m)}>
              {m}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}
