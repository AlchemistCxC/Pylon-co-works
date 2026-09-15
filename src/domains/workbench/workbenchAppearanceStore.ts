import { cloneCcLayout, DEFAULT_CC_LAYOUT, setCcHiddenState, setCcScaleState, updateCcPlacementState } from '../../ccLayoutState.ts'
import type { ThemeSettings } from '../../store.ts'
import { clampCcHeight, clampInputTypography, resolveVisibleStatusWidgetCount } from '../../ccHeightState.ts'
import {
  areWorkbenchAppearancesEqual,
  selectWorkbenchAppearance,
  type AppearanceCommand,
  type WorkbenchAppearanceSnapshot,
  type WorkbenchAppearanceStore,
} from './appearance.ts'

export interface ThemeStateSource {
  getState(): ThemeSettings
  subscribe(listener: (state: ThemeSettings, previousState: ThemeSettings) => void): () => void
}

export function createStaticWorkbenchAppearanceStore(
  initialTheme: ThemeSettings,
): WorkbenchAppearanceStore & { setTheme(theme: ThemeSettings): void } {
  let theme = structuredClone(initialTheme)
  let revision = 0
  let snapshot = selectWorkbenchAppearance(theme, revision)
  const listeners = new Set<() => void>()
  let destroyed = false

  const publish = (nextTheme: ThemeSettings) => {
    if (destroyed) return
    const candidate = selectWorkbenchAppearance(nextTheme, revision + 1)
    if (areWorkbenchAppearancesEqual(snapshot, candidate)) {
      theme = structuredClone(nextTheme)
      return
    }
    theme = structuredClone(nextTheme)
    revision += 1
    snapshot = selectWorkbenchAppearance(theme, revision)
    for (const listener of [...listeners]) listener()
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      if (destroyed) return () => {}
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    dispatch(command) {
      publish(reduceAppearanceCommand(theme, command))
    },
    setTheme(nextTheme) {
      publish(nextTheme)
    },
    destroy() {
      if (destroyed) return
      destroyed = true
      listeners.clear()
    },
  }
}

export function createVanillaWorkbenchAppearanceStore(
  source: ThemeStateSource,
  dispatchCommand: (command: AppearanceCommand) => void = () => {},
): WorkbenchAppearanceStore {
  let revision = 0
  let snapshot = selectWorkbenchAppearance(source.getState(), revision)
  const listeners = new Set<() => void>()
  let destroyed = false

  const unsubscribeSource = source.subscribe(nextTheme => {
    if (destroyed) return
    const candidate = selectWorkbenchAppearance(nextTheme, revision + 1)
    if (areWorkbenchAppearancesEqual(snapshot, candidate)) return
    revision += 1
    snapshot = selectWorkbenchAppearance(nextTheme, revision)
    for (const listener of [...listeners]) listener()
  })

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      if (destroyed) return () => {}
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    dispatch(command) {
      if (destroyed) return
      dispatchCommand(command)
    },
    destroy() {
      if (destroyed) return
      destroyed = true
      unsubscribeSource()
      listeners.clear()
    },
  }
}

export function reduceAppearanceCommand(
  theme: ThemeSettings,
  command: AppearanceCommand,
): ThemeSettings {
  switch (command.type) {
    case 'set-cc-edit-mode':
      return { ...theme, ccEditMode: command.enabled }
    case 'set-cc-hidden':
      return settleCcHeight({ ...theme, ccHidden: setCcHiddenState(theme.ccHidden, command.id, command.hidden) })
    case 'set-cc-scale':
      return { ...theme, ccScale: setCcScaleState(theme.ccScale, command.id, command.scale) }
    case 'set-cc-height': {
      const ccHeight = clampCcHeight(command.height, {
        inputMode: theme.inputMode,
        footerLayout: theme.footerLayout,
        hintMode: theme.cliHintMode,
        visibleStatusWidgets: resolveVisibleStatusWidgetCount({
          hiddenIds: theme.ccHidden,
          inputMode: theme.inputMode,
          ccStyle: theme.ccStyle,
          submitButtonMode: theme.inputSubmitButtonMode,
        }),
        cliOverflowMode: theme.cliOverflowMode,
      })
      return settleCcInputBounds({ ...theme, ccHeight }, 'ccHeight')
    }
    case 'update-cc-placement':
      return { ...theme, ccLayout: updateCcPlacementState(theme.ccLayout, command.id, command.placement) }
    case 'set-cc-property':
      return typeof command.value === 'number' && !Number.isFinite(command.value)
        ? theme
        : settleCcInputBounds({ ...theme, [command.key]: command.value }, command.key)
    case 'reset-cc-layout':
      return { ...theme, ccLayout: cloneCcLayout(DEFAULT_CC_LAYOUT) }
  }
}

function settleCcHeight(theme: ThemeSettings): ThemeSettings {
  const ccHeight = clampCcHeight(theme.ccHeight, {
    inputMode: theme.inputMode,
    footerLayout: theme.footerLayout,
    hintMode: theme.cliHintMode,
    visibleStatusWidgets: resolveVisibleStatusWidgetCount({
      hiddenIds: theme.ccHidden,
      inputMode: theme.inputMode,
      ccStyle: theme.ccStyle,
      submitButtonMode: theme.inputSubmitButtonMode,
    }),
    cliOverflowMode: theme.cliOverflowMode,
  })
  return { ...theme, ccHeight }
}

function settleCcInputBounds(theme: ThemeSettings, changedKey: string): ThemeSettings {
  const next = clampInputTypography({ ...theme }, changedKey)
  if (changedKey === 'ccHeight') {
    next.ccHeight = Math.min(400, Math.max(next.ccHeight, next.inputOffsetTop + next.inputHeight))
    return next
  }
  if (next.inputHeight + next.inputOffsetTop > next.ccHeight) {
    if (changedKey === 'inputHeight') {
      next.inputHeight = Math.max(0, next.ccHeight - next.inputOffsetTop)
    } else if (changedKey === 'inputOffsetTop') {
      next.inputOffsetTop = Math.max(0, next.ccHeight - next.inputHeight)
    }
  }
  return settleCcHeight(next)
}

export function snapshotRevision(snapshot: WorkbenchAppearanceSnapshot): number {
  return snapshot.revision
}
