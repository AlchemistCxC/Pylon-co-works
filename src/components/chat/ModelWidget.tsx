import { useStore } from '../../store'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'

const MODELS = ['deepseek-v4-flash', 'deepseek-v4-pro'] as const

export default function ModelWidget() {
  const activeProfile = useStore(s => s.profiles.find(x => x.id === s.activeProfileId))
  const model = activeProfile?.model || 'deepseek-v4-flash'

  return (
    <div className="cc-model-widget">
      <DropdownMenu.Root>
        <DropdownMenu.Trigger className="model-tag">{model} ▾</DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content className="model-menu" sideOffset={4}>
            {MODELS.map(m => (
              <DropdownMenu.Item key={m} className={`model-item ${m === model ? 'active' : ''}`}
                onClick={() => {
                  useStore.getState().addProfile({ ...(activeProfile || { id: '', name: '', persona: '', model: '' }), model: m })
                }}>
                {m}
              </DropdownMenu.Item>
            ))}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </div>
  )
}
