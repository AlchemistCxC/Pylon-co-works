import { useStore } from '../../store'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'

const MODELS = ['deepseek-v4-flash', 'deepseek-v4-pro'] as const

/**
 * modelVariant 取值：
 *   - 'dropdown'  : 默认下拉菜单（点击展开）
 *   - 'minimal'   : 单行 inline，点击循环切下一个（省空间）
 *   - 'badge'     : 圆角徽章样式，hover 切换
 */
export default function ModelWidget() {
  const variant = useStore(s => s.modelVariant) || 'dropdown'
  const activeProfile = useStore(s => s.profiles.find(x => x.id === s.activeProfileId))
  const model = activeProfile?.model || 'deepseek-v4-flash'

  const setModel = (m: string) => {
    const profile = useStore.getState().profiles.find(x => x.id === useStore.getState().activeProfileId)
    if (!profile) return
    useStore.getState().addProfile({ ...profile, model: m })
  }

  if (variant === 'minimal') {
    const idx = MODELS.indexOf(model as any)
    const next = MODELS[(idx + 1) % MODELS.length]
    return (
      <span className="cc-model-minimal" onClick={() => setModel(next)} title="点击切换模型">
        {model}
      </span>
    )
  }

  if (variant === 'badge') {
    return (
      <span className="cc-model-badge">{model}</span>
    )
  }

  // default: 'dropdown'
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger className="model-tag">{model} ▾</DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="model-menu" sideOffset={4}>
          {MODELS.map(m => (
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