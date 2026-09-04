import { useStore } from '../../store.ts'
import { useWorkspaceStore } from '../../workspaceStore.ts'
import type { AppearanceCommand, WorkbenchAppearanceStore } from './appearance.ts'
import { createVanillaWorkbenchAppearanceStore } from './workbenchAppearanceStore.ts'

export function createZustandWorkbenchAppearanceStore(): WorkbenchAppearanceStore {
  const readTheme = () => ({ ...useStore.getState(), showPet: useWorkspaceStore.getState().showPet })
  return createVanillaWorkbenchAppearanceStore(
    {
      getState: readTheme,
      subscribe: listener => {
        const notify = () => { const next = readTheme(); listener(next, next) }
        const unsubscribeTheme = useStore.subscribe(notify)
        const unsubscribeWorkspace = useWorkspaceStore.subscribe(notify)
        return () => { unsubscribeTheme(); unsubscribeWorkspace() }
      },
    },
    dispatchAppearanceCommand,
  )
}

function dispatchAppearanceCommand(command: AppearanceCommand): void {
  const state = useStore.getState()
  switch (command.type) {
    case 'set-cc-edit-mode':
      state.setCcEditMode(command.enabled)
      break
    case 'set-cc-hidden':
      state.setCcHidden(command.id, command.hidden)
      break
    case 'set-cc-scale':
      state.setCcScale(command.id, command.scale)
      break
    case 'set-cc-height':
      state.setCcHeight(command.height)
      break
    case 'update-cc-placement':
      state.updateCcPlacement(command.id, command.placement)
      break
    case 'set-cc-property':
      if (typeof command.value !== 'number' || Number.isFinite(command.value)) {
        state.setZoneField('cc', { [command.key]: command.value })
      }
      break
    case 'reset-cc-layout':
      state.resetCcLayout()
      break
  }
}
