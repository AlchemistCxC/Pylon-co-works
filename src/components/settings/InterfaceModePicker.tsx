import { Layers3, PanelsTopLeft, Terminal } from 'lucide-react'
import { useSyncExternalStore } from 'react'
import { activateInterfaceMode, interfaceModeIsUsable } from '../../application/transactions/activateInterfaceMode.ts'
import { useInterfaceModeStore } from '../../domains/interface/interfaceModeStore.ts'
import { getInterfaceModeRegistry } from '../../plugin-runtime/runtimeServices.ts'

export default function InterfaceModePicker() {
  const activeMode = useInterfaceModeStore(state => state.interfaceMode)
  const registry = getInterfaceModeRegistry()
  const modes = useSyncExternalStore(
    listener => registry.subscribe(listener),
    () => registry.getSnapshot(),
    () => registry.getSnapshot(),
  ).entries
  return (
    <div className="interface-mode-grid" role="radiogroup" aria-label="界面模式">
      {modes.map(entry => {
        const { id, label, description, icon } = entry.value
        const usable = interfaceModeIsUsable(entry.value)
        const Icon = icon === 'panels' ? PanelsTopLeft : icon === 'terminal' ? Terminal : Layers3
        return <button key={id} type="button" role="radio" aria-checked={activeMode === id}
          disabled={!usable}
          data-interface-mode-owner={entry.ownerPluginId}
          className={`interface-mode-card${activeMode === id ? ' active' : ''}`}
          onClick={() => activateInterfaceMode(id)}>
          <span className="interface-mode-icon" aria-hidden="true"><Icon size={20} /></span>
          <span><strong>{label}</strong><small>{usable ? description : `${description ?? ''} · 依赖的 Surface 未激活`}</small></span>
        </button>
      })}
    </div>
  )
}
