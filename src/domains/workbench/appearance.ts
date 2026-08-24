import { cloneCcLayout, type CcLayoutV3 } from '../../ccLayoutState.ts'
import { getSpinnerAssetPreset, getSpinnerVerbPreset, type SpinnerAssetId } from '../../components/chat/spinnerAssets.ts'
import { resolveSpinnerFrames, type SpinnerMarkerMode } from '../../components/chat/spinnerFrames.ts'
import type { ThemeSettings } from '../../store.ts'
import type { CcWidgetPlacement } from '../../ccLayoutState.ts'
import type { CcEditablePropertyKey, CcPropertyCommand } from '../cc/widgetDefinitions.ts'

export interface SpinnerAppearanceSnapshot {
  framePreset: SpinnerAssetId
  frames: readonly string[]
  motion: ReturnType<typeof getSpinnerAssetPreset>['motion']
  direction?: 'forward' | 'reverse' | 'alternate'
  intervalMs: number
  verbSet: string
  verbs: readonly string[]
  color: string
  stalledColor: string
  size: number
  doneMarker: string
  cancelledMarker: string
  errorMarker: string
  doneMarkerMode: SpinnerMarkerMode
  cancelledMarkerMode: SpinnerMarkerMode
  errorMarkerMode: SpinnerMarkerMode
}

export interface WorkbenchAppearanceSnapshot {
  revision: number
  uiScheme: 'light' | 'dark'
  msgStyle: string
  messageLayout: 'classic' | 'claude' | 'bubble'
  userName: string
  userPrefix: string
  userColor: string
  assistantDot: boolean
  assistantDotGlyph: string
  assistantDotColor: string
  assistantDotImage: string
  toolIndicator: string
  toolIndicatorGlow: number
  toolIndicatorGlowColor: string
  toolConnectorMode: string
  toolConnectorColor: string
  toolConnectorStyle: string
  toolConnectorWidth: number
  toolConnectorOpacity: number
  inputMode: string
  inputVariant: string
  inputShowPlaceholder: boolean
  inputShowHistoryHint: boolean
  inputSubmitButtonMode: string
  modelVariant: string
  modeVariant: string
  sendVariant: string
  attachVariant: string
  cliHintMode: string
  footerLayout: string
  cliOverflowMode: string
  ccVariant: string
  ccStyle: string
  ccHeight: number
  ccBgHeight: number
  ccLayout: CcLayoutV3
  ccHidden: readonly string[]
  ccScale: Readonly<Record<string, number>>
  ccEditMode: boolean
  ccProperties: Readonly<Pick<ThemeSettings, CcEditablePropertyKey>>
  showPet: boolean
  spinner: SpinnerAppearanceSnapshot
}

export type AppearanceCommand =
  | { type: 'set-cc-edit-mode'; enabled: boolean }
  | { type: 'set-cc-hidden'; id: string; hidden: boolean }
  | { type: 'set-cc-scale'; id: string; scale: number }
  | { type: 'set-cc-height'; height: number }
  | { type: 'update-cc-placement'; id: string; placement: Partial<CcWidgetPlacement> }
  | CcPropertyCommand
  | { type: 'reset-cc-layout' }

export interface WorkbenchAppearanceStore {
  getSnapshot(): WorkbenchAppearanceSnapshot
  subscribe(listener: () => void): () => void
  dispatch(command: AppearanceCommand): void
  destroy(): void
}

export function selectWorkbenchAppearance(
  theme: Readonly<ThemeSettings>,
  revision: number,
): WorkbenchAppearanceSnapshot {
  const asset = getSpinnerAssetPreset(theme.spinnerFramePreset)
  const verbPreset = getSpinnerVerbPreset(theme.spinnerVerbSet)
  const frames = resolveSpinnerFrames(theme.spinnerFramePreset, theme.spinnerCustomFrames)
  const customVerbs = theme.spinnerCustomVerbs
    .split(/[\n,，]+/)
    .map(verb => verb.trim())
    .filter(Boolean)

  return freezeAppearanceSnapshot({
    revision,
    uiScheme: theme.uiScheme === 'dark' ? 'dark' : 'light',
    msgStyle: theme.msgStyle || 'terminal',
    messageLayout: theme.messageLayout,
    userName: theme.userName,
    userPrefix: theme.userPrefix,
    userColor: theme.userColor,
    assistantDot: theme.assistantDot,
    assistantDotGlyph: theme.assistantDotGlyph,
    assistantDotColor: theme.assistantDotColor,
    assistantDotImage: theme.assistantDotImage,
    toolIndicator: theme.toolIndicator,
    toolIndicatorGlow: theme.toolIndicatorGlow,
    toolIndicatorGlowColor: theme.toolIndicatorGlowColor,
    toolConnectorMode: theme.toolConnectorMode,
    toolConnectorColor: theme.toolConnectorColor,
    toolConnectorStyle: theme.toolConnectorStyle,
    toolConnectorWidth: theme.toolConnectorWidth,
    toolConnectorOpacity: theme.toolConnectorOpacity,
    inputMode: theme.inputMode,
    inputVariant: theme.inputVariant,
    inputShowPlaceholder: theme.inputShowPlaceholder !== false,
    inputShowHistoryHint: theme.inputShowHistoryHint !== false,
    inputSubmitButtonMode: theme.inputSubmitButtonMode,
    modelVariant: theme.modelVariant,
    modeVariant: theme.modeVariant,
    sendVariant: theme.sendVariant,
    attachVariant: theme.attachVariant,
    cliHintMode: theme.cliHintMode,
    footerLayout: theme.footerLayout,
    cliOverflowMode: theme.cliOverflowMode,
    ccVariant: theme.ccVariant,
    ccStyle: theme.ccStyle,
    ccHeight: theme.ccHeight,
    ccBgHeight: theme.ccBgHeight,
    ccLayout: cloneCcLayout(theme.ccLayout),
    ccHidden: [...theme.ccHidden],
    ccScale: { ...theme.ccScale },
    ccEditMode: theme.ccEditMode,
    ccProperties: selectCcProperties(theme),
    showPet: theme.showPet,
    spinner: {
      framePreset: theme.spinnerFramePreset,
      frames: [...frames],
      motion: asset.motion,
      direction: asset.direction,
      intervalMs: Math.max(40, Math.min(1000, theme.spinnerIntervalMs || asset.defaultIntervalMs)),
      verbSet: theme.spinnerVerbSet,
      verbs: theme.spinnerVerbSet === 'custom' && customVerbs.length > 0 ? customVerbs : [...verbPreset.verbs],
      color: theme.spinnerColor,
      stalledColor: theme.spinnerStalledColor,
      size: theme.spinnerSize,
      doneMarker: theme.spinnerDoneMarker,
      cancelledMarker: theme.spinnerCancelledMarker,
      errorMarker: theme.spinnerErrorMarker,
      doneMarkerMode: theme.spinnerDoneMarkerMode,
      cancelledMarkerMode: theme.spinnerCancelledMarkerMode,
      errorMarkerMode: theme.spinnerErrorMarkerMode,
    },
  })
}

export function areWorkbenchAppearancesEqual(
  left: WorkbenchAppearanceSnapshot,
  right: WorkbenchAppearanceSnapshot,
): boolean {
  return appearanceSignature(left) === appearanceSignature(right)
}

function appearanceSignature(snapshot: WorkbenchAppearanceSnapshot): string {
  const { revision: _revision, ...appearance } = snapshot
  return JSON.stringify(appearance)
}

function freezeAppearanceSnapshot(snapshot: WorkbenchAppearanceSnapshot): WorkbenchAppearanceSnapshot {
  Object.freeze(snapshot.ccLayout.placements)
  for (const placement of Object.values(snapshot.ccLayout.placements)) Object.freeze(placement)
  Object.freeze(snapshot.ccLayout)
  Object.freeze(snapshot.ccHidden)
  Object.freeze(snapshot.ccScale)
  Object.freeze(snapshot.ccProperties)
  Object.freeze(snapshot.spinner.frames)
  Object.freeze(snapshot.spinner.verbs)
  Object.freeze(snapshot.spinner)
  return Object.freeze(snapshot)
}

function selectCcProperties(theme: Readonly<ThemeSettings>): Pick<ThemeSettings, CcEditablePropertyKey> {
  return {
    inputBg: theme.inputBg,
    inputTextColor: theme.inputTextColor,
    inputFontSize: theme.inputFontSize,
    inputMinHeight: theme.inputMinHeight,
    inputMode: theme.inputMode,
    inputVariant: theme.inputVariant,
    cliLineWidth: theme.cliLineWidth,
    cliLineColor: theme.cliLineColor,
    cliLinePadding: theme.cliLinePadding,
    ccStyle: theme.ccStyle,
    ekgWidth: theme.ekgWidth,
    ekgGreen: theme.ekgGreen,
    ekgYellow: theme.ekgYellow,
    ekgRed: theme.ekgRed,
    barTrackColor: theme.barTrackColor,
    barHeight: theme.barHeight,
    barFillFollow: theme.barFillFollow,
    barFillColor: theme.barFillColor,
    modelVariant: theme.modelVariant,
    modeVariant: theme.modeVariant,
    sendVariant: theme.sendVariant,
    attachVariant: theme.attachVariant,
  }
}
