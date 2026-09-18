/** 预设层 · 终端预设补全：TERMINAL_COMPLETION / completeTerminalPreset。 */

import type { ThemeSettings } from '../store.ts'
import { DEFAULT_CC_LAYOUT } from '../ccLayoutState.ts'
import { THEME_DEFAULTS, THEME_SETTING_KEYS } from '../themeFieldDefs.ts'
import type { GlobalPreset, PresetName } from './types.ts'

/**
 * Terminal-like presets are deliberately complete snapshots.  The preset
 * reducer starts from DEFAULTS, but leaving newer renderer fields out of a
 * preset made the visual result depend on whichever preset had been applied
 * before it.  Keep the ownership model (presets still only provide theme
 * values), while filling every declared scalar and the three structured CC
 * values here.
 */
const TERMINAL_COMPLETION: Partial<ThemeSettings> = {
  ...Object.fromEntries(
    THEME_SETTING_KEYS
      .filter(key => THEME_DEFAULTS[key] !== undefined)
      .map(key => [key, THEME_DEFAULTS[key]]),
  ),
  ccHidden: [],
  ccScale: {},
  ccLayout: DEFAULT_CC_LAYOUT,
}

type TerminalPresetName = Extract<PresetName, 'claude' | 'nord' | 'tokyo' | 'solarized' | 'amber' | 'matrix'>

const TERMINAL_VISUAL_COMPLETION: Record<TerminalPresetName, Partial<ThemeSettings>> = {
  // Claude and Solarized retain their original palette and typography.  These
  // values only close gaps introduced by newer fields in the renderer.
  claude: {
    uiScheme: 'dark', codeFont: 'mono', chatFont: 'mono', msgFont: 'mono',
    toolOk: '#4ade80', toolRun: '#D77757', toolErr: '#f87171',
    toolIndicator: '●', toolIndicatorRun: 'circle', toolIndicatorOk: 'check', toolIndicatorErr: 'cross', toolIndicatorGlow: 0, toolConnectorMode: 'none',
    spinnerStalledColor: '#B8755A', spinnerDoneMarker: '✓', spinnerCancelledMarker: '■', spinnerErrorMarker: '!',
    assistantDotGlyph: '●', assistantDotColor: '#D77757', messageRadius: 0,
    editorFontSize: 13, editorLineHeight: 1.5, editorGutterColor: '#8a9199', editorGutterBg: 'transparent',
    editorSelection: 'rgba(215,119,87,0.22)', editorActiveLine: 'rgba(255,255,255,0.04)',
    editorTabActive: '#D77757', editorModifiedMark: '#FFC107',
  },
  solarized: {
    uiScheme: 'light', codeFont: 'mono', chatFont: 'mono', msgFont: 'mono',
    toolOk: '#859900', toolRun: '#268bd2', toolErr: '#dc322f',
    toolIndicator: '●', toolIndicatorRun: 'circle', toolIndicatorOk: 'check', toolIndicatorErr: 'cross', toolIndicatorGlow: 0, toolConnectorMode: 'none',
    spinnerStalledColor: '#dc322f', spinnerDoneMarker: '✓', spinnerCancelledMarker: '■', spinnerErrorMarker: '!',
    assistantDotGlyph: '●', assistantDotColor: '#268bd2', messageRadius: 0,
    editorFontSize: 13, editorLineHeight: 1.5, editorGutterColor: '#93a1a1', editorGutterBg: 'transparent',
    editorSelection: 'rgba(38,139,210,0.18)', editorActiveLine: 'rgba(88,110,117,0.06)',
    editorTabActive: '#268bd2', editorModifiedMark: '#b58900',
  },
  // The remaining three are intentionally more opinionated workstations:
  // each has a distinct status rail, richer state colors, and an explicit
  // command/input contract so switching presets is visually deterministic.
  nord: {
    uiScheme: 'dark', codeFont: 'mono', chatFont: 'mono', msgFont: 'mono', msgStyle: 'terminal', messageLayout: 'classic',
    toolIndicator: '◆', toolIndicatorRun: 'diamond', toolIndicatorOk: 'check', toolIndicatorErr: 'cross', toolIndicatorGlow: 1, toolConnectorMode: 'follow', toolConnectorStyle: 'solid', toolConnectorWidth: 1, toolConnectorOpacity: 0.72,
    assistantDot: true, assistantDotGlyph: '●', assistantDotColor: '#88c0d0',
    messageAssistantBg: 'rgba(136,192,208,0.035)', messageReasoningBg: 'rgba(129,161,193,0.05)', messageBorderColor: 'rgba(136,192,208,0.16)', messageRadius: 0,
    spinnerFramePreset: 'braille', spinnerVerbSet: 'engineering', spinnerStalledColor: '#d08770',
    editorSelection: 'rgba(136,192,208,0.22)', editorActiveLine: 'rgba(216,222,233,0.045)', editorTabActive: '#88c0d0', editorModifiedMark: '#ebcb8b',
    inputMode: 'cli', inputVariant: 'cli', ccVariant: 'terminal', cliHintMode: 'compact', footerLayout: 'free',
  },
  tokyo: {
    uiScheme: 'dark', codeFont: 'mono', chatFont: 'mono', msgFont: 'mono', msgStyle: 'terminal', messageLayout: 'classic',
    toolIndicator: '▶', toolIndicatorRun: 'play', toolIndicatorOk: 'star', toolIndicatorErr: 'cross', toolIndicatorGlow: 2, toolConnectorMode: 'follow', toolConnectorStyle: 'pulse', toolConnectorWidth: 1, toolConnectorOpacity: 0.8,
    assistantDot: true, assistantDotGlyph: '◆', assistantDotColor: '#bb9af7',
    messageAssistantBg: 'rgba(122,162,247,0.035)', messageReasoningBg: 'rgba(187,154,247,0.055)', messageBorderColor: 'rgba(122,162,247,0.18)', messageRadius: 0,
    spinnerFramePreset: 'scan', spinnerVerbSet: 'analysis', spinnerStalledColor: '#f7768e',
    editorSelection: 'rgba(122,162,247,0.22)', editorActiveLine: 'rgba(192,202,245,0.05)', editorTabActive: '#7aa2f7', editorModifiedMark: '#e0af68',
    inputMode: 'cli', inputVariant: 'cli', ccVariant: 'terminal', cliHintMode: 'compact', footerLayout: 'free',
  },
  amber: {
    uiScheme: 'dark', codeFont: 'mono', chatFont: 'mono', msgFont: 'mono', msgStyle: 'terminal', messageLayout: 'classic',
    toolIndicator: '■', toolIndicatorRun: 'square', toolIndicatorOk: 'check', toolIndicatorErr: 'warning', toolIndicatorGlow: 1, toolConnectorMode: 'follow', toolConnectorStyle: 'solid', toolConnectorWidth: 1, toolConnectorOpacity: 0.86,
    assistantDot: true, assistantDotGlyph: '●', assistantDotColor: '#ffb000',
    messageAssistantBg: 'rgba(255,176,0,0.035)', messageReasoningBg: 'rgba(255,107,53,0.045)', messageBorderColor: 'rgba(255,176,0,0.18)', messageRadius: 0,
    spinnerStalledColor: '#ff6b35', spinnerDoneMarker: '✓', spinnerCancelledMarker: '■', spinnerErrorMarker: '!',
    editorSelection: 'rgba(255,176,0,0.2)', editorActiveLine: 'rgba(255,204,85,0.05)', editorTabActive: '#ffb000', editorModifiedMark: '#ff6b35',
    inputMode: 'cli', inputVariant: 'cli', ccVariant: 'terminal', cliHintMode: 'compact', footerLayout: 'free',
  },
  // Matrix phosphor-green CRT — deep void background, electric green palette,
  // subtle scan-line feel via spacing and glow. Distinct from Nord/Tokyo in
  // having a unified green palette rather than accent-neutral-surface separation.
  matrix: {
    uiScheme: 'dark', codeFont: 'mono', chatFont: 'mono', msgFont: 'mono', msgStyle: 'terminal', messageLayout: 'classic',
    toolIndicator: '»', toolIndicatorRun: 'triangle', toolIndicatorOk: 'check', toolIndicatorErr: 'cross', toolIndicatorGlow: 2, toolIndicatorGlowColor: '#39ff14', toolConnectorMode: 'follow', toolConnectorStyle: 'pulse', toolConnectorWidth: 1, toolConnectorOpacity: 0.75,
    assistantDot: true, assistantDotGlyph: '►', assistantDotColor: '#39ff14',
    messageAssistantBg: 'rgba(57,255,20,0.028)', messageReasoningBg: 'rgba(57,255,20,0.045)', messageBorderColor: 'rgba(57,255,20,0.14)', messageRadius: 0,
    spinnerFramePreset: 'scan', spinnerVerbSet: 'engineering', spinnerStalledColor: '#ff3c3c', spinnerDoneMarker: '✓', spinnerCancelledMarker: '■', spinnerErrorMarker: '!',
    editorSelection: 'rgba(57,255,20,0.18)', editorActiveLine: 'rgba(57,255,20,0.05)', editorTabActive: '#39ff14', editorModifiedMark: '#ff3c3c',
    inputMode: 'cli', inputVariant: 'cli', ccVariant: 'terminal', cliHintMode: 'compact', footerLayout: 'free',
  },
}

export function completeTerminalPreset(preset: GlobalPreset): GlobalPreset {
  if (!(preset.name in TERMINAL_VISUAL_COMPLETION)) return preset
  const name = preset.name as TerminalPresetName
  return {
    ...preset,
    theme: {
      ...TERMINAL_COMPLETION,
      ...preset.theme,
      ...TERMINAL_VISUAL_COMPLETION[name],
      // Keep structured values fresh per preset; preserve intentional legacy
      // choices (Claude hides its send widget) while preventing a
      // Settings edit from sharing references with the registry.
      ccHidden: Array.isArray(preset.theme.ccHidden) ? [...preset.theme.ccHidden] : [],
      ccScale: preset.theme.ccScale && typeof preset.theme.ccScale === 'object' ? { ...preset.theme.ccScale } : {},
      ccLayout: structuredClone(preset.theme.ccLayout ?? DEFAULT_CC_LAYOUT),
    },
  }
}
