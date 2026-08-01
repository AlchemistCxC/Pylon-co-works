import type { ThemeSettings } from './store'

/**
 * themeFields — 主题字段单一真值表（阶段 3：主题系统声明式化）。
 *
 * 一份分组声明生成三份消费物：
 * - ZONE_FIELDS（presets.ts 的分区字段映射）
 * - THEME_SETTINGS_KEYS（customPresets.ts 的自定义预设白名单，= 各 zone 并集）
 * - ZONES（themeMigration / store 的 zone 路由）
 *
 * 新增字段：在对应 zone 组加一行即可，其余清单自动生成；漏加字段会被
 * 编译期穷举断言（_assertAllCovered）拦截。
 */

export const THEME_FIELD_GROUPS = {
  global: [
    'transparency', 'bgBlur', 'globalFont', 'globalFontSize', 'globalBgImage',
    'globalBgColor', 'uiScheme',
    'userName', 'userPrefix', 'userColor',
  ],
  sidebar: [
    'sidebarBg', 'sidebarBgImage', 'sidebarWidth',
    'sidebarTransparency', 'sidebarBlur',
    'sidebarTextColor', 'sidebarNameSize', 'sidebarGroupSize',
  ],
  chat: [
    'chatBg', 'chatBgImage', 'chatTransparency', 'chatBlur',
    'chatFont', 'chatFontSize', 'chatLineHeight',
    'chatTextColor', 'chatCodeColor', 'chatCodeBg',
    'toolOk', 'toolRun', 'toolErr',
    'toolNameColor', 'toolSummaryColor',
    'userTagBg', 'userTagText',
    'toolIndicator', 'toolIndicatorGlow', 'toolIndicatorGlowColor',
    'toolConnectorMode', 'toolConnectorColor', 'toolConnectorStyle', 'toolConnectorWidth', 'toolConnectorOpacity',
    'spinnerFramePreset', 'spinnerCustomFrames', 'spinnerVerbSet', 'spinnerCustomVerbs',
    'spinnerDoneMarker', 'spinnerCancelledMarker', 'spinnerErrorMarker',
    'spinnerDoneMarkerMode', 'spinnerCancelledMarkerMode', 'spinnerErrorMarkerMode',
    'spinnerIntervalMs', 'spinnerColor', 'spinnerSize',
    'msgStyle', 'msgFont', 'msgTextColor', 'msgLineHeight', 'messageLayout',
  ],
  cc: [
    'ccHeight', 'ccBgHeight', 'ccBg', 'ccBgImage', 'ccStatusFontSize',
    'ccStyle', 'ccVariant', 'ccLayout', 'ccHidden', 'ccScale',
    'inputBg', 'inputBgImage', 'inputTextColor', 'inputPlaceholder',
    'inputSendBg', 'inputFocusBorder', 'inputFontSize', 'inputMinHeight',
    'inputMode', 'inputVariant', 'inputShowPlaceholder', 'inputShowHistoryHint', 'inputSubmitButtonMode', 'cliLineWidth', 'cliLineColor', 'cliTextColor', 'cliPromptColor', 'cliLinePadding', 'cliContentOffsetY', 'cliHintMode', 'footerLayout', 'cliOverflowMode',
    'statusBg', 'statusBgImage',
    'ekgWidth', 'ekgFontSize',
    'ekgGreen', 'ekgYellow', 'ekgRed',
    'ekgLineWidth', 'ekgAmplitudeMax', 'ekgSpeedBase', 'ekgSpeedMax',
    'ekgLeftColor', 'ekgMovingColor', 'ekgConsumedColor',
    'barTrackColor', 'barFillColor', 'barFillFollow', 'barHeight',
    'tokenDisplay',
    'pillBg', 'pillText', 'prismOnColor',
    'modelVariant', 'modeVariant', 'sendVariant', 'attachVariant',
  ],
  right: [
    'rightBg', 'rightBgImage', 'rightWidth',
    'rightTransparency', 'rightBlur',
  ],
} as const satisfies Record<string, readonly (keyof ThemeSettings)[]>

export const ZONES = Object.keys(THEME_FIELD_GROUPS) as (keyof typeof THEME_FIELD_GROUPS)[]

/** 分区字段映射（presets.ts 的 ZONE_FIELDS 生成源） */
export const ZONE_FIELDS: Record<string, readonly (keyof ThemeSettings)[]> = THEME_FIELD_GROUPS

/** 自定义预设白名单 = 各 zone 字段并集（customPresets.ts 的 THEME_SETTINGS_KEYS 生成源） */
export const THEME_SETTINGS_KEYS: readonly (keyof ThemeSettings)[] = [
  ...new Set(Object.values(THEME_FIELD_GROUPS).flat()),
] as (keyof ThemeSettings)[]

/** 非视觉元字段（zone 路由/UI 元状态，持久化但不属于自定义预设内容） */
const META_KEYS = ['activePreset', 'dirty', 'ccEditMode'] as const

// 编译期穷举断言：ThemeSettings 每个字段必须落入某 zone 或 META_KEYS。
// MissingField 非空时类型不兼容，tsc 报错。
type AllDeclared =
  | (typeof THEME_FIELD_GROUPS)[keyof typeof THEME_FIELD_GROUPS][number]
  | (typeof META_KEYS)[number]
type MissingField = Exclude<keyof ThemeSettings, AllDeclared>
const _assertAllCovered: MissingField = undefined as never
void _assertAllCovered
