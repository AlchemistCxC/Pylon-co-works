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
  /** number 单位后缀（'px' 等）；cssVar 注入时格式化 `${value}${unit}` */
  unit?: string
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
  transparency: { ...N('global', '透明度', 0, 1, 0.05), group: "玻璃效果", cssVar: '--t' },
  bgBlur: { ...N('global', '模糊', 0, 40, 2), group: "玻璃效果", unit: 'px', cssVar: '--blur' },
  globalFont: { ...S('global', '字体', ['system', 'mono']), group: "字体", },
  globalFontSize: { ...N('global', '基础字号', 12, 24), group: "字体", unit: 'px' },
  globalBgImage: { ...T('global', '背景图'), control: 'bgImage', group: "玻璃效果", },
  globalBgColor: { ...C('global', '背景底色'), group: "玻璃效果", },
  uiScheme: { ...S('global', 'UI 配色', ['light', 'dark']), group: "玻璃效果", },
  userName: T('global', '显示名'),
  userPrefix: T('global', '前缀'),
  userColor: C('global', '名字颜色'),

  // ── layout ──
  showTabBar: B('layout', 'Tab 条'),
  showSidebar: B('layout', '侧栏'),
  showPet: B('layout', '宠物'),

  // ── sidebar ──
  sidebarBg: { ...C('sidebar', '背景色'), group: "背景", },
  sidebarBgImage: { ...T('sidebar', '背景图'), control: 'bgImage', group: "背景", },
  sidebarWidth: { ...N('sidebar', '栏宽', 160, 400), group: "布局", unit: 'px' },
  sidebarTransparency: { ...N('sidebar', '透明度', 0, 1, 0.05), group: "玻璃效果", },
  sidebarBlur: { ...N('sidebar', '模糊', 0, 40, 2), group: "玻璃效果", unit: 'px' },
  sidebarTextColor: { ...C('sidebar', '文字颜色'), group: "文字", },
  sidebarNameSize: { ...N('sidebar', '会话名字号', 11, 20), group: "文字", unit: 'px' },
  sidebarGroupSize: { ...N('sidebar', '分组标题字号', 10, 16), group: "文字", unit: 'px' },

  // ── chat ──
  chatBg: { ...C('chat', '背景色'), group: "背景", },
  chatBgImage: { ...T('chat', '背景图'), control: 'bgImage', group: "背景", },
  chatTransparency: { ...N('chat', '透明度', 0, 1, 0.05), group: "玻璃效果", },
  chatBlur: { ...N('chat', '模糊', 0, 40, 2), group: "玻璃效果", unit: 'px' },
  chatFont: { ...S('chat', '字体', ['mono', 'system']), group: "字体", },
  chatFontSize: { ...N('chat', '字号', 12, 22), group: "字体", unit: 'px' },
  chatLineHeight: { ...N('chat', '行高', 1.2, 2.5, 0.1), group: "字体", },
  chatTextColor: { ...C('chat', '文字'), group: "颜色", },
  chatCodeColor: { ...C('chat', '内联代码'), group: "颜色", },
  chatCodeBg: { ...C('chat', '代码背景'), group: "颜色", },
  synKeyword: { ...C('chat', '语法·关键字'), cssVar: '--syn-kw', group: "语法高亮", },
  synString: { ...C('chat', '语法·字符串'), cssVar: '--syn-str', group: "语法高亮", },
  synComment: { ...C('chat', '语法·注释'), cssVar: '--syn-cmt', group: "语法高亮", },
  synLiteral: { ...C('chat', '语法·数字'), cssVar: '--syn-lit', group: "语法高亮", },
  synEntity: { ...C('chat', '语法·类型'), cssVar: '--syn-ent', group: "语法高亮", },
  synFunction: { ...C('chat', '语法·函数'), cssVar: '--syn-fn', group: "语法高亮", },
  synVariable: { ...C('chat', '语法·变量'), cssVar: '--syn-var', group: "语法高亮", },
  synProperty: { ...C('chat', '语法·属性'), cssVar: '--syn-prop', group: "语法高亮", },
  synRegex: { ...C('chat', '语法·正则'), cssVar: '--syn-re', group: "语法高亮", },
  synMarkupHeading: { ...C('chat', '语法·标题'), cssVar: '--syn-mh', group: "语法高亮", },
  synCoReference: { ...C('chat', '语法·引用'), cssVar: '--syn-cor', hidden: true },
  synSupport: { ...C('chat', '语法·模块'), cssVar: '--syn-support', group: "语法高亮", },
  toolOk: { ...C('chat', '工具·完成'), group: "指示器", },
  toolRun: { ...C('chat', '工具·运行中'), group: "指示器", },
  toolErr: { ...C('chat', '工具·错误'), group: "指示器", },
  toolNameColor: { ...C('chat', '工具名'), group: "文字 & 标签", },
  toolSummaryColor: { ...C('chat', '工具摘要'), group: "文字 & 标签", },
  userTagBg: { ...C('chat', '标签背景'), group: "文字 & 标签", },
  userTagText: { ...C('chat', '标签文字'), group: "文字 & 标签", },
  diffAdded: { ...C('chat', 'Diff·新增'), group: "Diff", },
  diffRemoved: { ...C('chat', 'Diff·删除'), group: "Diff", },
  // toolIndicator 走 widgetRegistry 动态选项（toolIndicatorOptions），不进声明式 UI
  toolIndicator: { ...S('chat', '指示器形状', ['●', '■', '◆', '▶', '✦']), hidden: true },
  toolIndicatorGlow: { ...N('chat', '指示器辉光', 0, 20, 1), group: "指示器 & 连接线", },
  toolIndicatorGlowColor: { ...C('chat', '辉光色'), group: "指示器 & 连接线", },
  toolConnectorMode: { ...S('chat', '连接线', ['none', 'fixed', 'follow']), group: "指示器 & 连接线", },
  toolConnectorColor: { ...C('chat', '连接线色'), group: "指示器 & 连接线", },
  toolConnectorStyle: { ...S('chat', '线样式', ['solid', 'dotted', 'pulse']), group: "指示器 & 连接线", },
  toolConnectorWidth: { ...N('chat', '线宽', 1, 6), group: "指示器 & 连接线", },
  toolConnectorOpacity: { ...N('chat', '线透明度', 0.1, 1, 0.05), group: "指示器 & 连接线", },
  spinnerFramePreset: { ...S('chat', '动画预设', ['sparkles', 'ascii-line', 'braille', 'dots', 'orbit', 'clock', 'wave', 'blocks', 'scan', 'custom']), group: "Spinner", },
  spinnerCustomFrames: { ...T('chat', '自定义帧'), group: "Spinner", },
  spinnerVerbSet: { ...S('chat', '文案语言', ['zh', 'en', 'analysis', 'engineering', 'custom']), group: "Spinner", },
  spinnerCustomVerbs: { ...T('chat', '自定义文案'), group: "Spinner", },
  spinnerDoneMarker: { ...T('chat', '完成标记'), control: 'spinnerMarker', group: "Spinner", },
  spinnerCancelledMarker: { ...T('chat', '取消标记'), control: 'spinnerMarker', group: "Spinner", },
  spinnerErrorMarker: { ...T('chat', '错误标记'), control: 'spinnerMarker', group: "Spinner", },
  spinnerDoneMarkerMode: { ...S('chat', '完成标记模式', ['frame', 'custom']), group: "Spinner", },
  spinnerCancelledMarkerMode: { ...S('chat', '取消标记模式', ['frame', 'custom']), group: "Spinner", },
  spinnerErrorMarkerMode: { ...S('chat', '错误标记模式', ['frame', 'custom']), group: "Spinner", },
  spinnerIntervalMs: { ...N('chat', '动画间隔', 40, 1000, 10), group: "Spinner", },
  spinnerColor: { ...C('chat', 'Spinner 颜色'), group: "Spinner", },
  spinnerSize: { ...N('chat', 'Spinner 大小', 10, 32), group: "Spinner", unit: 'px' },
  msgStyle: { ...S('chat', '消息风格', ['terminal', 'bubble']), group: "风格", },
  msgFont: { ...S('chat', '消息字体', ['mono', 'system']), group: "风格", },
  msgTextColor: { ...C('chat', '消息文字'), group: "风格", },
  msgLineHeight: { ...N('chat', '消息行距', 1.2, 2.5, 0.1), group: "风格", },
  messageLayout: { ...S('chat', '信息层级', ['classic', 'claude', 'bubble']), group: "风格", },

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
  group: "外观风格",
  },
  ccBgHeight: { ...N('cc', '背景高度', 64, 400), group: "中控背景", },
  ccBg: { ...C('cc', '背景色'), group: "外观风格", },
  ccBgImage: { ...T('cc', '背景图'), control: 'bgImage', group: "外观风格", },
  ccStatusFontSize: { ...N('cc', '信息字号', 14, 20), group: "中控背景", unit: 'px' },
  ccStyle: { ...S('cc', '上下文', ['wave', 'bar', 'ring', 'numeric']), group: "控件样式", },
  ccVariant: { ...S('cc', '整体风格', ['terminal', 'glass', 'pill']), group: "外观风格", },
  ccLayout: H({ type: 'text', label: '布局', zone: 'cc', noCssVar: true }),
  ccHidden: H({ type: 'text', label: '隐藏控件', zone: 'cc', noCssVar: true }),
  ccScale: H({ type: 'text', label: '控件缩放', zone: 'cc', noCssVar: true }),
  inputBg: { ...C('cc', '输入背景'), group: "输入与状态", },
  inputBgImage: { ...T('cc', '输入背景图'), control: 'bgImage', group: "输入与状态", },
  inputTextColor: { ...C('cc', '输入文字'), group: "输入与状态", },
  inputPlaceholder: { ...C('cc', '占位符'), group: "输入与状态", },
  inputSendBg: { ...C('cc', '发送按钮'), group: "输入与状态", },
  inputFocusBorder: { ...C('cc', '焦点边框'), group: "输入与状态", },
  inputFontSize: { ...N('cc', '输入字号', 12, 22), group: "输入与状态", unit: 'px' },
  inputMinHeight: { ...N('cc', '输入最小高', 32, 120), group: "输入与状态", unit: 'px' },
  inputMode: { ...S('cc', '输入模式', ['cli', 'default']), group: "输入与状态", },
  inputVariant: { ...S('cc', '输入栏', ['cli', 'composer', 'compact', 'command']), syncOnChange: ['inputMode'], group: "控件样式", },
  inputShowPlaceholder: { ...S('cc', 'Placeholder', ['shown', 'hidden']), group: "控件样式", },
  inputShowHistoryHint: { ...S('cc', '历史提示', ['shown', 'hidden']), group: "控件样式", },
  inputSubmitButtonMode: { ...S('cc', '发送按钮', ['inline', 'external', 'hidden']), group: "控件样式", },
  cliLineWidth: { ...N('cc', 'CLI 线宽', 1, 4), group: "输入与状态", unit: 'px' },
  cliLineColor: { ...C('cc', 'CLI 线色'), group: "输入与状态", },
  cliTextColor: { ...C('cc', 'CLI 文字'), group: "输入与状态", },
  cliPromptColor: { ...C('cc', '提示符颜色'), group: "控件样式", },
  cliLinePadding: { ...N('cc', 'CLI 内边距', 0, 16), group: "输入与状态", unit: 'px' },
  cliContentOffsetY: { ...N('cc', '内容垂直偏移', -6, 6), group: "控件样式", unit: 'px' },
  cliHintMode: { ...S('cc', '命令提示', ['hidden', 'compact', 'full']), group: "控件样式", },
  footerLayout: { ...S('cc', 'Footer 布局', ['free', 'peri']), group: "控件样式", },
  cliOverflowMode: { ...S('cc', '多行策略', ['fixed-scroll', 'grow', 'overlay']), group: "控件样式", },
  statusBg: { ...C('cc', '状态背景'), group: "输入与状态", },
  statusBgImage: { ...T('cc', '状态背景图'), control: 'bgImage', group: "输入与状态", },
  ekgWidth: { ...N('cc', '波形宽度', 60, 300), group: "波形与用量", unit: 'px' },
  ekgFontSize: { ...N('cc', '波形字号', 10, 24), group: "波形与用量", unit: 'px' },
  ekgGreen: { ...C('cc', '波形·正常'), group: "波形与用量", },
  ekgYellow: { ...C('cc', '波形·警示'), group: "波形与用量", },
  ekgRed: { ...C('cc', '波形·危险'), group: "波形与用量", },
  ekgLineWidth: { ...N('cc', '波形线宽', 1, 6), group: "波形与用量", unit: 'px' },
  ekgAmplitudeMax: { ...N('cc', '波形幅度', 2, 40), group: "波形与用量", unit: 'px' },
  ekgSpeedBase: { ...N('cc', '波形速度基', 0.1, 2, 0.1), group: "波形与用量", },
  ekgSpeedMax: { ...N('cc', '波形速度峰', 0.5, 6, 0.1), group: "波形与用量", },
  ekgLeftColor: { ...C('cc', '波形·左色'), group: "波形与用量", },
  ekgMovingColor: { ...C('cc', '波形·动色'), group: "波形与用量", },
  ekgConsumedColor: { ...C('cc', '波形·已耗'), group: "波形与用量", },
  barTrackColor: { ...C('cc', '柱·轨道'), group: "波形与用量", },
  barFillColor: { ...C('cc', '柱·填充'), group: "波形与用量", },
  barFillFollow: { ...B('cc', '柱·跟随用量'), group: "波形与用量", },
  barHeight: { ...N('cc', '柱高', 4, 24), group: "波形与用量", },
  tokenDisplay: { ...S('cc', 'Token 显示', ['ekg', 'pct', 'bar', 'ring', 'tokens']), group: "波形与用量", },
  pillBg: { ...C('cc', '胶囊背景'), group: "波形与用量", },
  pillText: { ...C('cc', '胶囊文字'), group: "波形与用量", },
  prismOnColor: { ...C('cc', 'Prism 开启'), group: "波形与用量", },
  modelVariant: { ...S('cc', '模型', ['dropdown', 'minimal', 'badge']), group: "控件样式", },
  modeVariant: { ...S('cc', '模式', ['pill', 'badge', 'minimal']), group: "控件样式", },
  sendVariant: { ...S('cc', '发送', ['icon', 'square', 'minimal']), group: "控件样式", },
  attachVariant: { ...S('cc', '附件', ['icon', 'square', 'minimal']), group: "控件样式", },
  modeAutoColor: { ...C('cc', '模式·auto'), group: "控件样式", },
  modeEditColor: { ...C('cc', '模式·edit'), group: "控件样式", },

  // ── right ──
  rightBg: { ...C('right', '背景色'), group: "外观", },
  rightBgImage: { ...T('right', '背景图'), control: 'bgImage', group: "外观", },
  rightWidth: { ...N('right', '宽度', 200, 400), group: "外观", unit: 'px' },
  rightTransparency: { ...N('right', '透明度', 0, 1, 0.05), group: "玻璃效果", },
  rightBlur: { ...N('right', '模糊', 0, 40, 2), group: "玻璃效果", unit: 'px' },

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
export const GROUP_ORDER: Record<string, readonly string[]> = {
  global: ["玻璃效果", "字体"],
  sidebar: ["背景", "布局", "玻璃效果", "文字"],
  chat: ["背景", "字体", "颜色", "玻璃效果", "语法高亮", "指示器", "文字 & 标签", "指示器 & 连接线", "Diff", "Spinner", "风格"],
  cc: ["外观风格", "控件样式", "输入与状态", "波形与用量", "中控背景"],
  right: ["外观", "玻璃效果"],
}
