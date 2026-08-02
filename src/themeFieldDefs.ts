import type { ThemeSettings } from './store'
import { resolveCcMinHeight, resolveVisibleStatusWidgetCount } from './ccHeightState.ts'

/**
 * themeFieldDefs — 声明式主题字段定义（自定义系统骨架核心）。
 *
 * 每个字段携带类型元数据（color/number/select/boolean/text）+ label +
 * 范围/选项 + zone 归属 + cssVar 注入名。生成物：
 * - THEME_FIELD_KEYS（白名单，替代 THEME_SETTINGS_KEYS 手写并集）
 * - ZONE_FIELDS（zone → 字段，替代 THEME_FIELD_GROUPS）
 * - Settings UI 自动渲染（骨架3）
 * - cssVars 注入派生（App.tsx 从 defs 循环生成，替代手写 60+ 行）
 *
 * 新增字段：此处加一行 + store.ts 加类型/默认值即可，其余自动跟上。
 */

export const ZONES = ['global', 'layout', 'sidebar', 'chat', 'cc', 'right'] as const
export type ZoneName = (typeof ZONES)[number]

export type ThemeFieldType = 'color' | 'number' | 'select' | 'boolean' | 'text'

export interface ThemeFieldDef {
  type: ThemeFieldType
  label: string
  zone: ZoneName
  /** Settings 分组标题（声明式 UI 按 group 渲染） */
  group?: string
  /** 特殊控件标识（渲染器分发到专用组件） */
  control?: 'default' | 'bgImage' | 'spinnerMarker'
  /** select/boolean 字段的联动：onChange 时同步写这些字段（如 inputVariant→inputMode） */
  syncOnChange?: readonly string[]
  /** number 范围/步长 */
  min?: number
  max?: number
  step?: number
  /** number 动态最小值（优先于 min，如 ccHeight 依赖布局状态） */
  minFn?: (t: ThemeSettings) => number
  /** select 选项 */
  options?: readonly string[]
  /** CSS 变量注入名；缺省 = `--${kebab(fieldName)}` */
  cssVar?: string
  /** 不注入 CSS 变量（逻辑/对象字段） */
  noCssVar?: boolean
  /** 不在 Settings UI 自动渲染（特殊控件或内部字段） */
  hidden?: boolean
  /** META 字段：仅持久化、不进预设白名单（ccEditMode/activePreset/dirty） */
  meta?: boolean
}

const C = (zone: ZoneName, label: string): ThemeFieldDef => ({ type: 'color', label, zone })
const N = (zone: ZoneName, label: string, min?: number, max?: number, step?: number): ThemeFieldDef => ({ type: 'number', label, zone, min, max, step })
const S = (zone: ZoneName, label: string, options: readonly string[]): ThemeFieldDef => ({ type: 'select', label, zone, options })
const B = (zone: ZoneName, label: string): ThemeFieldDef => ({ type: 'boolean', label, zone })
const T = (zone: ZoneName, label: string): ThemeFieldDef => ({ type: 'text', label, zone })
const H = (def: ThemeFieldDef): ThemeFieldDef => ({ ...def, hidden: true })

export const THEME_FIELD_DEFS = {
  // ── global ──
  accent: { ...C('global', '强调色'), cssVar: '--accent' },
  transparency: N('global', '透明度', 0, 1, 0.05),
  bgBlur: N('global', '模糊', 0, 40, 2),
  globalFont: S('global', '字体', ['system', 'mono']),
  globalFontSize: N('global', '基础字号', 12, 24),
  globalBgImage: { ...T('global', '背景图'), control: 'bgImage' },
  globalBgColor: C('global', '背景底色'),
  uiScheme: S('global', 'UI 配色', ['light', 'dark']),
  userName: T('global', '显示名'),
  userPrefix: T('global', '前缀'),
  userColor: C('global', '名字颜色'),

  // ── layout ──
  showTabBar: B('layout', 'Tab 条'),
  showSidebar: B('layout', '侧栏'),
  showPet: B('layout', '宠物'),

  // ── sidebar ──
  sidebarBg: C('sidebar', '背景色'),
  sidebarBgImage: { ...T('sidebar', '背景图'), control: 'bgImage' },
  sidebarWidth: N('sidebar', '栏宽', 160, 400),
  sidebarTransparency: N('sidebar', '透明度', 0, 1, 0.05),
  sidebarBlur: N('sidebar', '模糊', 0, 40, 2),
  sidebarTextColor: C('sidebar', '文字颜色'),
  sidebarNameSize: N('sidebar', '会话名字号', 11, 20),
  sidebarGroupSize: N('sidebar', '分组标题字号', 10, 16),

  // ── chat ──
  chatBg: C('chat', '背景色'),
  chatBgImage: { ...T('chat', '背景图'), control: 'bgImage' },
  chatTransparency: N('chat', '透明度', 0, 1, 0.05),
  chatBlur: N('chat', '模糊', 0, 40, 2),
  chatFont: S('chat', '字体', ['mono', 'system']),
  chatFontSize: N('chat', '字号', 12, 22),
  chatLineHeight: N('chat', '行高', 1.2, 2.5, 0.1),
  chatTextColor: C('chat', '文字'),
  chatCodeColor: C('chat', '内联代码'),
  chatCodeBg: C('chat', '代码背景'),
  synKeyword: { ...C('chat', '语法·关键字'), cssVar: '--syn-kw' },
  synString: { ...C('chat', '语法·字符串'), cssVar: '--syn-str' },
  synComment: { ...C('chat', '语法·注释'), cssVar: '--syn-cmt' },
  synLiteral: { ...C('chat', '语法·数字'), cssVar: '--syn-lit' },
  synEntity: { ...C('chat', '语法·类型'), cssVar: '--syn-ent' },
  synFunction: { ...C('chat', '语法·函数'), cssVar: '--syn-fn' },
  synVariable: { ...C('chat', '语法·变量'), cssVar: '--syn-var' },
  synProperty: { ...C('chat', '语法·属性'), cssVar: '--syn-prop' },
  synRegex: { ...C('chat', '语法·正则'), cssVar: '--syn-re' },
  synMarkupHeading: { ...C('chat', '语法·标题'), cssVar: '--syn-mh' },
  synCoReference: { ...C('chat', '语法·引用'), cssVar: '--syn-cor', hidden: true },
  synSupport: { ...C('chat', '语法·模块'), cssVar: '--syn-support' },
  toolOk: C('chat', '工具·完成'),
  toolRun: C('chat', '工具·运行中'),
  toolErr: C('chat', '工具·错误'),
  toolNameColor: C('chat', '工具名'),
  toolSummaryColor: C('chat', '工具摘要'),
  userTagBg: C('chat', '标签背景'),
  userTagText: C('chat', '标签文字'),
  diffAdded: C('chat', 'Diff·新增'),
  diffRemoved: C('chat', 'Diff·删除'),
  // toolIndicator 走 widgetRegistry 动态选项（toolIndicatorOptions），不进声明式 UI
  toolIndicator: { ...S('chat', '指示器形状', ['●', '■', '◆', '▶', '✦']), hidden: true },
  toolIndicatorGlow: N('chat', '指示器辉光', 0, 20, 1),
  toolIndicatorGlowColor: C('chat', '辉光色'),
  toolConnectorMode: S('chat', '连接线', ['none', 'fixed', 'follow']),
  toolConnectorColor: C('chat', '连接线色'),
  toolConnectorStyle: S('chat', '线样式', ['solid', 'dotted', 'pulse']),
  toolConnectorWidth: N('chat', '线宽', 1, 6),
  toolConnectorOpacity: N('chat', '线透明度', 0.1, 1, 0.05),
  spinnerFramePreset: S('chat', '动画预设', ['sparkles', 'ascii-line', 'braille', 'dots', 'orbit', 'clock', 'wave', 'blocks', 'scan', 'custom']),
  spinnerCustomFrames: T('chat', '自定义帧'),
  spinnerVerbSet: S('chat', '文案语言', ['zh', 'en', 'analysis', 'engineering', 'custom']),
  spinnerCustomVerbs: T('chat', '自定义文案'),
  spinnerDoneMarker: { ...T('chat', '完成标记'), control: 'spinnerMarker' },
  spinnerCancelledMarker: { ...T('chat', '取消标记'), control: 'spinnerMarker' },
  spinnerErrorMarker: { ...T('chat', '错误标记'), control: 'spinnerMarker' },
  spinnerDoneMarkerMode: S('chat', '完成标记模式', ['frame', 'custom']),
  spinnerCancelledMarkerMode: S('chat', '取消标记模式', ['frame', 'custom']),
  spinnerErrorMarkerMode: S('chat', '错误标记模式', ['frame', 'custom']),
  spinnerIntervalMs: N('chat', '动画间隔', 40, 1000, 10),
  spinnerColor: C('chat', 'Spinner 颜色'),
  spinnerSize: N('chat', 'Spinner 大小', 10, 32),
  msgStyle: S('chat', '消息风格', ['terminal', 'bubble']),
  msgFont: S('chat', '消息字体', ['mono', 'system']),
  msgTextColor: C('chat', '消息文字'),
  msgLineHeight: N('chat', '消息行距', 1.2, 2.5, 0.1),
  messageLayout: S('chat', '信息层级', ['classic', 'claude', 'bubble']),

  // ── cc ──
  ccHeight: {
    ...N('cc', '高度', 64, 400),
    minFn: t => resolveCcMinHeight({
      inputMode: t.inputMode,
      footerLayout: t.footerLayout || 'free',
      hintMode: t.cliHintMode || 'full',
      visibleStatusWidgets: resolveVisibleStatusWidgetCount({
        hiddenIds: t.ccHidden || [],
        inputMode: t.inputMode,
        ccStyle: t.ccStyle || 'wave',
      }),
      cliOverflowMode: t.cliOverflowMode || 'fixed-scroll',
    }),
  },
  ccBgHeight: N('cc', '背景高度', 64, 400),
  ccBg: C('cc', '背景色'),
  ccBgImage: { ...T('cc', '背景图'), control: 'bgImage' },
  ccStatusFontSize: N('cc', '信息字号', 14, 20),
  ccStyle: S('cc', '上下文', ['wave', 'bar', 'ring', 'numeric']),
  ccVariant: S('cc', '整体风格', ['terminal', 'glass', 'pill']),
  ccLayout: H({ type: 'text', label: '布局', zone: 'cc', noCssVar: true }),
  ccHidden: H({ type: 'text', label: '隐藏控件', zone: 'cc', noCssVar: true }),
  ccScale: H({ type: 'text', label: '控件缩放', zone: 'cc', noCssVar: true }),
  inputBg: C('cc', '输入背景'),
  inputBgImage: { ...T('cc', '输入背景图'), control: 'bgImage' },
  inputTextColor: C('cc', '输入文字'),
  inputPlaceholder: C('cc', '占位符'),
  inputSendBg: C('cc', '发送按钮'),
  inputFocusBorder: C('cc', '焦点边框'),
  inputFontSize: N('cc', '输入字号', 12, 22),
  inputMinHeight: N('cc', '输入最小高', 32, 120),
  inputMode: S('cc', '输入模式', ['cli', 'default']),
  inputVariant: { ...S('cc', '输入栏', ['cli', 'composer', 'compact', 'command']), syncOnChange: ['inputMode'] },
  inputShowPlaceholder: S('cc', 'Placeholder', ['shown', 'hidden']),
  inputShowHistoryHint: S('cc', '历史提示', ['shown', 'hidden']),
  inputSubmitButtonMode: S('cc', '发送按钮', ['inline', 'external', 'hidden']),
  cliLineWidth: N('cc', 'CLI 线宽', 1, 4),
  cliLineColor: C('cc', 'CLI 线色'),
  cliTextColor: C('cc', 'CLI 文字'),
  cliPromptColor: C('cc', '提示符颜色'),
  cliLinePadding: N('cc', 'CLI 内边距', 0, 16),
  cliContentOffsetY: N('cc', '内容垂直偏移', -6, 6),
  cliHintMode: S('cc', '命令提示', ['hidden', 'compact', 'full']),
  footerLayout: S('cc', 'Footer 布局', ['free', 'peri']),
  cliOverflowMode: S('cc', '多行策略', ['fixed-scroll', 'grow', 'overlay']),
  statusBg: C('cc', '状态背景'),
  statusBgImage: { ...T('cc', '状态背景图'), control: 'bgImage' },
  ekgWidth: N('cc', '波形宽度', 60, 300),
  ekgFontSize: N('cc', '波形字号', 10, 24),
  ekgGreen: C('cc', '波形·正常'),
  ekgYellow: C('cc', '波形·警示'),
  ekgRed: C('cc', '波形·危险'),
  ekgLineWidth: N('cc', '波形线宽', 1, 6),
  ekgAmplitudeMax: N('cc', '波形幅度', 2, 40),
  ekgSpeedBase: N('cc', '波形速度基', 0.1, 2, 0.1),
  ekgSpeedMax: N('cc', '波形速度峰', 0.5, 6, 0.1),
  ekgLeftColor: C('cc', '波形·左色'),
  ekgMovingColor: C('cc', '波形·动色'),
  ekgConsumedColor: C('cc', '波形·已耗'),
  barTrackColor: C('cc', '柱·轨道'),
  barFillColor: C('cc', '柱·填充'),
  barFillFollow: B('cc', '柱·跟随用量'),
  barHeight: N('cc', '柱高', 4, 24),
  tokenDisplay: S('cc', 'Token 显示', ['ekg', 'pct', 'bar', 'ring', 'tokens']),
  pillBg: C('cc', '胶囊背景'),
  pillText: C('cc', '胶囊文字'),
  prismOnColor: C('cc', 'Prism 开启'),
  modelVariant: S('cc', '模型', ['dropdown', 'minimal', 'badge']),
  modeVariant: S('cc', '模式', ['pill', 'badge', 'minimal']),
  sendVariant: S('cc', '发送', ['icon', 'square', 'minimal']),
  attachVariant: S('cc', '附件', ['icon', 'square', 'minimal']),
  modeAutoColor: C('cc', '模式·auto'),
  modeEditColor: C('cc', '模式·edit'),

  // ── right ──
  rightBg: C('right', '背景色'),
  rightBgImage: { ...T('right', '背景图'), control: 'bgImage' },
  rightWidth: N('right', '宽度', 200, 400),
  rightTransparency: N('right', '透明度', 0, 1, 0.05),
  rightBlur: N('right', '模糊', 0, 40, 2),

  // ── META（持久化但非预设内容）──
  ccEditMode: { type: 'text', label: '编辑模式', zone: 'cc', noCssVar: true, hidden: true, meta: true },
  activePreset: { type: 'text', label: '活动预设', zone: 'global', noCssVar: true, hidden: true, meta: true },
  dirty: { type: 'text', label: '脏标记', zone: 'global', noCssVar: true, hidden: true, meta: true },
} as const satisfies Record<keyof ThemeSettings, ThemeFieldDef>

export type ThemeFieldKey = keyof typeof THEME_FIELD_DEFS

export const THEME_FIELD_KEYS = Object.keys(THEME_FIELD_DEFS) as ThemeFieldKey[]

/** 预设白名单（非 META 字段）——替代 customPresets.ts 的 THEME_SETTINGS_KEYS 手写并集 */
export const THEME_SETTING_KEYS: readonly ThemeFieldKey[] = THEME_FIELD_KEYS.filter(key => !THEME_FIELD_DEFS[key].meta)

export const ZONE_FIELDS: Record<string, ThemeFieldKey[]> = ZONES.reduce((acc, zone) => {
  acc[zone] = THEME_FIELD_KEYS.filter(key => THEME_FIELD_DEFS[key].zone === zone && !THEME_FIELD_DEFS[key].meta)
  return acc
}, {} as Record<string, ThemeFieldKey[]>)

/** cssVar 注入表：--xxx → 字段名（供 App.tsx 循环注入） */
export const THEME_CSS_VAR_MAP: Readonly<Record<string, ThemeFieldKey>> = THEME_FIELD_KEYS.reduce((acc, key) => {
  const def = THEME_FIELD_DEFS[key]
  if (def.noCssVar) return acc
  if (def.type === 'color' || def.type === 'number') {
    const cssVar = def.cssVar ?? `--${key.replace(/[A-Z]/g, m => `-${m.toLowerCase()}`)}`
    acc[cssVar] = key
  }
  return acc
}, {} as Record<string, ThemeFieldKey>)

/** kebab-case 字段名 → cssVar（无显式声明时） */
export function fieldToCssVar(key: string): string {
  return `--${key.replace(/[A-Z]/g, m => `-${m.toLowerCase()}`)}`
}

/**
 * Settings 分组映射（声明式 UI 按此渲染字段组）。
 * 纯字段组由渲染器自动生成；含自定义内容的组（预设/强调色/布局骨架/
 * 窗口/配置备份/布局编辑）保留在 Settings 手写。
 */
export const GROUP_MAP: Record<string, Record<string, readonly ThemeFieldKey[]>> = {
  global: {
    '玻璃效果': ['transparency', 'bgBlur', 'globalBgImage', 'globalBgColor', 'uiScheme'],
    '字体': ['globalFont', 'globalFontSize'],
  },
  sidebar: {
    '背景': ['sidebarBg', 'sidebarBgImage'],
    '布局': ['sidebarWidth'],
    '玻璃效果': ['sidebarTransparency', 'sidebarBlur'],
    '文字': ['sidebarTextColor', 'sidebarNameSize', 'sidebarGroupSize'],
  },
  chat: {
    '背景': ['chatBg', 'chatBgImage'],
    '字体': ['chatFont', 'chatFontSize', 'chatLineHeight'],
    '颜色': ['chatTextColor', 'chatCodeColor', 'chatCodeBg'],
    '玻璃效果': ['chatTransparency', 'chatBlur'],
    '语法高亮': ['synKeyword', 'synString', 'synComment', 'synLiteral', 'synEntity', 'synFunction', 'synVariable', 'synProperty', 'synRegex', 'synMarkupHeading', 'synSupport'],
    '指示器': ['toolOk', 'toolRun', 'toolErr'],
    '文字 & 标签': ['toolNameColor', 'toolSummaryColor', 'userTagBg', 'userTagText'],
    '指示器 & 连接线': ['toolIndicatorGlow', 'toolIndicatorGlowColor', 'toolConnectorMode', 'toolConnectorColor', 'toolConnectorStyle', 'toolConnectorWidth', 'toolConnectorOpacity'],
    'Diff': ['diffAdded', 'diffRemoved'],
    'Spinner': ['spinnerFramePreset', 'spinnerCustomFrames', 'spinnerVerbSet', 'spinnerCustomVerbs', 'spinnerDoneMarker', 'spinnerCancelledMarker', 'spinnerErrorMarker', 'spinnerDoneMarkerMode', 'spinnerCancelledMarkerMode', 'spinnerErrorMarkerMode', 'spinnerIntervalMs', 'spinnerColor', 'spinnerSize'],
    '风格': ['messageLayout', 'msgStyle', 'msgFont', 'msgTextColor', 'msgLineHeight'],
  },
  cc: {
    '外观风格': ['ccVariant', 'ccHeight', 'ccBg', 'ccBgImage'],
    '控件样式': ['inputVariant', 'inputShowPlaceholder', 'inputShowHistoryHint', 'inputSubmitButtonMode', 'footerLayout', 'cliOverflowMode', 'cliPromptColor', 'cliContentOffsetY', 'cliHintMode', 'ccStyle', 'ccStatusFontSize', 'modelVariant', 'modeVariant', 'sendVariant', 'attachVariant', 'modeAutoColor', 'modeEditColor'],
    '输入与状态': ['inputBg', 'inputBgImage', 'inputTextColor', 'inputPlaceholder', 'inputSendBg', 'inputFocusBorder', 'inputFontSize', 'inputMinHeight', 'inputMode', 'cliLineWidth', 'cliLineColor', 'cliTextColor', 'cliLinePadding', 'statusBg', 'statusBgImage'],
    '波形与用量': ['ekgWidth', 'ekgFontSize', 'ekgGreen', 'ekgYellow', 'ekgRed', 'ekgLineWidth', 'ekgAmplitudeMax', 'ekgSpeedBase', 'ekgSpeedMax', 'ekgLeftColor', 'ekgMovingColor', 'ekgConsumedColor', 'barTrackColor', 'barFillColor', 'barFillFollow', 'barHeight', 'tokenDisplay', 'pillBg', 'pillText', 'prismOnColor'],
    '中控背景': ['ccBgHeight', 'ccStatusFontSize'],
  },
  right: {
    '外观': ['rightBg', 'rightBgImage', 'rightWidth'],
    '玻璃效果': ['rightTransparency', 'rightBlur'],
  },
}
