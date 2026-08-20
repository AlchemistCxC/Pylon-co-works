import { toCssBackgroundImage } from '../../backgroundImage.ts'
import { cloneCcLayout } from '../../ccLayoutState.ts'
import type { CustomPreset } from '../../customPresets.ts'
import { DEFAULTS } from '../theme/themeDefaults.ts'
import { GLOBAL_PRESETS } from '../../presets.ts'
import {
  THEME_CSS_VAR_MAP,
  THEME_FIELD_DEFS,
  THEME_SETTING_KEYS,
  type ThemeFieldKey,
} from '../../themeFieldDefs.ts'
import type { ThemeSettings } from '../../store.ts'

export const WORKBENCH_DATA_ATTRIBUTES = [
  'data-ui-scheme',
  'data-msg-style',
  'data-message-layout',
  'data-footer-layout',
  'data-cli-overflow-mode',
] as const

export const WORKBENCH_DOM_CLASSES = [
  'chat-view',
  'term',
  'term-row',
  'term-user',
  'term-assistant',
  'term-reasoning',
  'term-tool',
  'term-code-block',
  'term-spinner',
  'control-center',
  'input-bar',
  'pet-companion',
] as const

const WORKBENCH_THEME_KEYS = new Set<ThemeFieldKey>([
  ...THEME_SETTING_KEYS.filter(key => ['chat', 'cc'].includes(THEME_FIELD_DEFS[key].zone)),
  'accent',
  'globalFont',
  'globalFontSize',
  'uiScheme',
  'userName',
  'userPrefix',
  'userColor',
  'showPet',
])

const WORKBENCH_DERIVED_CSS_VARIABLES = [
  '--chat-bg-image',
  '--input-bg-image',
  '--status-bg-image',
  '--chat-font',
  '--msg-font',
  '--msg-text',
] as const

export const WORKBENCH_CSS_VARIABLES = Array.from(new Set([
  ...Object.entries(THEME_CSS_VAR_MAP)
    .filter(([, key]) => WORKBENCH_THEME_KEYS.has(key))
    .map(([cssVariable]) => cssVariable),
  ...WORKBENCH_DERIVED_CSS_VARIABLES,
])).sort() as readonly string[]

export interface WorkbenchThemeFixture {
  id: string
  label: string
  kind: 'default' | 'builtin' | 'custom' | 'mixed' | 'dirty' | 'boundary-min' | 'boundary-max'
  theme: ThemeSettings
  cssVariables: Record<string, string>
  dataAttributes: Record<(typeof WORKBENCH_DATA_ATTRIBUTES)[number], string>
}

export interface WorkbenchSkinFixtureSet {
  generatedAt: string
  source: {
    builtinPresetIds: string[]
    customPresetIds: string[]
    themeSettingCount: number
    cssVariableCount: number
  }
  fixtures: WorkbenchThemeFixture[]
}

function cloneTheme(theme: ThemeSettings): ThemeSettings {
  return {
    ...structuredClone(theme),
    ccLayout: cloneCcLayout(theme.ccLayout),
  }
}

function resolveDataAttributes(theme: ThemeSettings): WorkbenchThemeFixture['dataAttributes'] {
  return {
    'data-ui-scheme': theme.uiScheme || 'light',
    'data-msg-style': theme.msgStyle || 'terminal',
    'data-message-layout': theme.messageLayout || 'classic',
    'data-footer-layout': theme.footerLayout || 'free',
    'data-cli-overflow-mode': theme.cliOverflowMode || 'fixed-scroll',
  }
}

function resolveCssVariables(theme: ThemeSettings): Record<string, string> {
  const state = theme as unknown as Record<string, unknown>
  const variables: Record<string, string> = {
    '--chat-bg-image': toCssBackgroundImage(theme.chatBgImage),
    '--input-bg-image': toCssBackgroundImage(theme.inputBgImage),
    '--status-bg-image': toCssBackgroundImage(theme.statusBgImage),
    '--chat-font': theme.chatFont === 'mono' ? 'var(--mono)' : theme.chatFont === 'serif' ? 'var(--serif)' : 'var(--font)',
    '--msg-font': theme.msgFont === 'mono' ? 'var(--mono)' : theme.msgFont === 'serif' ? 'var(--serif)' : 'var(--font)',
    '--msg-text': theme.msgTextColor || 'var(--chat-text-color,var(--text))',
  }

  for (const [cssVariable, key] of Object.entries(THEME_CSS_VAR_MAP)) {
    if (!WORKBENCH_THEME_KEYS.has(key) || cssVariable in variables) continue
    const definition = THEME_FIELD_DEFS[key]
    const value = state[key]
    if (value === undefined || (definition.type === 'color' && value === '')) continue
    variables[cssVariable] = definition.type === 'number' && definition.unit
      ? `${value}${definition.unit}`
      : String(value)
  }

  return variables
}

function makeFixture(
  id: string,
  label: string,
  kind: WorkbenchThemeFixture['kind'],
  theme: ThemeSettings,
): WorkbenchThemeFixture {
  const snapshot = cloneTheme(theme)
  return {
    id,
    label,
    kind,
    theme: snapshot,
    cssVariables: resolveCssVariables(snapshot),
    dataAttributes: resolveDataAttributes(snapshot),
  }
}

function mergeTheme(delta: Partial<ThemeSettings>): ThemeSettings {
  return cloneTheme({ ...DEFAULTS, ...structuredClone(delta) } as ThemeSettings)
}

function boundaryValue(key: ThemeFieldKey, edge: 'min' | 'max'): unknown {
  const definition = THEME_FIELD_DEFS[key]
  const current = DEFAULTS[key]

  if (definition.type === 'number') {
    return edge === 'min'
      ? definition.min ?? current
      : definition.max ?? current
  }
  if (definition.type === 'select') {
    const options = definition.options ?? []
    return edge === 'min' ? options[0] ?? current : options.at(-1) ?? current
  }
  if (definition.type === 'boolean') return edge === 'max'
  if (definition.type === 'color') return edge === 'min' ? '' : '#abcdef'
  if (key === 'ccLayout') return cloneCcLayout(DEFAULTS.ccLayout)
  if (key === 'ccHidden') return edge === 'min' ? [] : ['ekg', 'tasks']
  if (key === 'ccScale') return edge === 'min' ? {} : { ekg: 50, tasks: 200 }
  return edge === 'min' ? '' : `fixture-${key}`
}

function createBoundaryTheme(edge: 'min' | 'max'): ThemeSettings {
  const theme = cloneTheme(DEFAULTS)
  for (const key of THEME_SETTING_KEYS) {
    ;(theme as unknown as Record<string, unknown>)[key] = boundaryValue(key, edge)
  }
  theme.ccLayout = cloneCcLayout(DEFAULTS.ccLayout)
  theme.ccHeight = Number.isFinite(theme.ccHeight) ? theme.ccHeight : DEFAULTS.ccHeight
  theme.ccBgHeight = Math.max(theme.ccHeight, Number.isFinite(theme.ccBgHeight) ? theme.ccBgHeight : theme.ccHeight)
  return theme
}

function createMixedTheme(): ThemeSettings {
  const byName = new Map(GLOBAL_PRESETS.map(preset => [preset.name, preset.theme]))
  return mergeTheme({
    ...byName.get('glass'),
    ...Object.fromEntries(
      Object.entries(byName.get('tokyo') ?? {}).filter(([key]) => THEME_FIELD_DEFS[key as ThemeFieldKey]?.zone === 'chat'),
    ),
    ...Object.fromEntries(
      Object.entries(byName.get('amber') ?? {}).filter(([key]) => THEME_FIELD_DEFS[key as ThemeFieldKey]?.zone === 'cc'),
    ),
  })
}

function createDirtyTheme(): ThemeSettings {
  return mergeTheme({
    msgStyle: DEFAULTS.msgStyle === 'terminal' ? 'bubble' : 'terminal',
    messageLayout: 'bubble',
    assistantDot: true,
    assistantDotGlyph: '✦',
    inputVariant: 'composer',
    inputMode: 'default',
    ccHidden: ['ekg'],
    ccScale: { model: 125 },
    showPet: false,
  })
}

export function createWorkbenchSkinFixtureSet(
  customPresets: readonly CustomPreset[] = [],
  generatedAt = new Date().toISOString(),
): WorkbenchSkinFixtureSet {
  const fixtures: WorkbenchThemeFixture[] = [
    makeFixture('default', '默认主题', 'default', DEFAULTS),
    ...GLOBAL_PRESETS.map(preset => makeFixture(`builtin-${preset.name}`, preset.label, 'builtin', mergeTheme(preset.theme))),
    ...customPresets.map(preset => makeFixture(`custom-${preset.id}`, preset.name, 'custom', mergeTheme(preset.theme))),
    makeFixture('mixed-zones', '分区混合主题', 'mixed', createMixedTheme()),
    makeFixture('dirty-custom', '逐字段调整主题', 'dirty', createDirtyTheme()),
    makeFixture('schema-boundary-min', 'Schema 最小边界', 'boundary-min', createBoundaryTheme('min')),
    makeFixture('schema-boundary-max', 'Schema 最大边界', 'boundary-max', createBoundaryTheme('max')),
  ]

  return {
    generatedAt,
    source: {
      builtinPresetIds: GLOBAL_PRESETS.map(preset => preset.name),
      customPresetIds: customPresets.map(preset => preset.id),
      themeSettingCount: THEME_SETTING_KEYS.length,
      cssVariableCount: WORKBENCH_CSS_VARIABLES.length,
    },
    fixtures,
  }
}

export function validateWorkbenchSkinFixtureSet(fixtureSet: WorkbenchSkinFixtureSet): string[] {
  const errors: string[] = []
  const fixtureIds = new Set<string>()

  for (const fixture of fixtureSet.fixtures) {
    if (fixtureIds.has(fixture.id)) errors.push(`fixture id 重复：${fixture.id}`)
    fixtureIds.add(fixture.id)

    for (const attribute of WORKBENCH_DATA_ATTRIBUTES) {
      if (!fixture.dataAttributes[attribute]) errors.push(`${fixture.id} 缺少 ${attribute}`)
    }
    for (const key of THEME_SETTING_KEYS) {
      if ((fixture.theme as unknown as Record<string, unknown>)[key] === undefined) {
        errors.push(`${fixture.id} 缺少主题字段 ${key}`)
      }
    }
    for (const cssVariable of WORKBENCH_CSS_VARIABLES) {
      const mappedKey = THEME_CSS_VAR_MAP[cssVariable]
      const definition = mappedKey ? THEME_FIELD_DEFS[mappedKey] : undefined
      const mayUseCssFallback = definition?.type === 'color'
        && (fixture.theme as unknown as Record<string, unknown>)[mappedKey] === ''
      if (!(cssVariable in fixture.cssVariables) && !mayUseCssFallback) {
        errors.push(`${fixture.id} 缺少 CSS variable ${cssVariable}`)
      }
    }
  }

  for (const preset of GLOBAL_PRESETS) {
    if (!fixtureIds.has(`builtin-${preset.name}`)) errors.push(`缺少内置预设 fixture：${preset.name}`)
  }

  return errors
}
