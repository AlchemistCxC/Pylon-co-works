import { useStore } from '../theme/themeStore.ts'
import { useRightRailStore } from '../workspace/layoutRailsStore.ts'
import type { AppearanceCommand, WorkbenchAppearanceStore } from './appearance.ts'
import { createVanillaWorkbenchAppearanceStore } from './workbenchAppearanceStore.ts'

export function createZustandWorkbenchAppearanceStore(): WorkbenchAppearanceStore {
  const readTheme = () => ({ ...useStore.getState(), showPet: useRightRailStore.getState().showPet })
  return createVanillaWorkbenchAppearanceStore(
    {
      getState: readTheme,
      subscribe: listener => {
        const notify = () => { const next = readTheme(); listener(next, next) }
        const unsubscribeTheme = useStore.subscribe(notify)
        // showPet（A-V12 并入壳层偏好 store）变化需驱动外观投影重算。
        const unsubscribeRails = useRightRailStore.subscribe(notify)
        return () => { unsubscribeTheme(); unsubscribeRails() }
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
