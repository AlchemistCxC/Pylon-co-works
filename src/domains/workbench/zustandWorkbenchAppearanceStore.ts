import { useStore } from '../../store.ts'
import type { AppearanceCommand, WorkbenchAppearanceStore } from './appearance.ts'
import { createVanillaWorkbenchAppearanceStore } from './workbenchAppearanceStore.ts'

export function createZustandWorkbenchAppearanceStore(): WorkbenchAppearanceStore {
  return createVanillaWorkbenchAppearanceStore(
    {
      getState: () => useStore.getState(),
      subscribe: listener => useStore.subscribe((state, previousState) => listener(state, previousState)),
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
