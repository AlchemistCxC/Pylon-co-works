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
  control?: 'default' | 'bgImage' | 'spinnerMarker' | 'schemeChip'
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
  /** 条件显示：返回 false 时 Settings 不渲染该字段（如 spinner 自定义帧依赖预设） */
  showIf?: (t: ThemeSettings) => boolean
  /** 高阶选项：渲染器折叠进组内"高级"子区，平时不占屏 */
  advanced?: boolean
  /** number 显示后缀（set-val，如 'px'/'%'/'ms'）；配合 percent 处理 0-1 值 */
  suffix?: string
  /** number 值为 0-1 时按百分比显示（*100） */
  percent?: boolean
  /** 字段提示文案（Row 内 set-hint） */
  hint?: string
  /** select 选项 */
  options?: readonly string[]
  /** CSS 变量注入名；缺省 = `--${kebab(fieldName)}` */
  cssVar?: string
  /** 不注入 CSS 变量（逻辑/对象字段） */
  noCssVar?: boolean
  /** 不在 Settings UI 自动渲染（特殊控件或内部字段） */
  hidden?: boolean
  /** META 字段：仅持久化、不进预设白名单（ccEditMode/appliedPreset/dirty） */
  meta?: boolean
  /** 字段默认值（THEME_DEFAULTS 由 defs 派生；对象字段 ccLayout/ccHidden/ccScale 及 appliedPreset/custom 无标量默认） */
  default?: string | number | boolean
  /** W2-13（F3-A）：快速层基础字段标记（basic 清单来自 defs，组件不硬编码） */
  tier?: 'basic'
}

const C = (zone: ZoneName, label: string): ThemeFieldDef => ({ type: 'color', label, zone })
const N = (zone: ZoneName, label: string, min?: number, max?: number, step?: number): ThemeFieldDef => ({ type: 'number', label, zone, min, max, step })
const S = (zone: ZoneName, label: string, options: readonly string[]): ThemeFieldDef => ({ type: 'select', label, zone, options })
const B = (zone: ZoneName, label: string): ThemeFieldDef => ({ type: 'boolean', label, zone })
const T = (zone: ZoneName, label: string): ThemeFieldDef => ({ type: 'text', label, zone })
const H = (def: ThemeFieldDef): ThemeFieldDef => ({ ...def, hidden: true })

export const THEME_FIELD_DEFS = {
  // ── global ──
  accent: { ...C('global', '强调色'), tier: 'basic', default: '#3b82f6', cssVar: '--accent', group: "强调色", hint: '链接、用户前缀、选中/焦点、spinner 光扫的统一取色' },
  transparency: { ...N('global', '透明度', 0, 1, 0.05), default: 0.85, group: "玻璃效果", cssVar: '--t', percent: true, suffix: '%' },
  bgBlur: { ...N('global', '模糊', 0, 40, 2), default: 16, group: "玻璃效果", unit: 'px', cssVar: '--blur', suffix: 'px' },
  globalFont: { ...S('global', '字体', ['system', 'mono']), default: 'system', group: "字体", },
  globalFontSize: { ...N('global', '基础字号', 12, 24), tier: 'basic', default: 18, group: "字体", unit: 'px' },
  globalBgImage: { ...T('global', '背景图'), default: '', control: 'bgImage', group: "玻璃效果", },
  globalBgColor: { ...C('global', '背景底色'), tier: 'basic', default: '#e8e8ec', group: "玻璃效果", hint: '终端/桌面背景模拟色' },
  uiScheme: { ...S('global', 'UI 配色', ['light', 'dark']), tier: 'basic', default: 'light', group: "玻璃效果", control: 'schemeChip' },
  userName: { ...T('global', '显示名'), default: '', group: "个人信息" },
  userPrefix: { ...T('global', '前缀'), default: '❯', group: "个人信息" },
  // ChatView 内联 style 应用（style={{color: userColor}}），不注入 CSS var
  userColor: { ...C('global', '名字颜色'), default: '', group: "个人信息", noCssVar: true },
  // 布局显隐并入 global zone（布局骨架组渲染在全局 tab），layout zone 无独立 tab/预设
  showTabBar: { ...B('global', 'Tab 条'), default: true, group: "布局骨架" },
  showSidebar: { ...B('global', '侧栏'), default: true, group: "布局骨架" },
  showPet: { ...B('global', '宠物'), default: true, group: "布局骨架", hint: '隐藏 Tab/侧栏/宠物可拼出 CC 式纯聊天单流' },

  // ── sidebar ──
  sidebarBg: { ...C('sidebar', '背景色'), default: 'rgba(0,0,0,0.02)', group: "背景", },
  sidebarBgImage: { ...T('sidebar', '背景图'), default: '', control: 'bgImage', group: "背景", },
  sidebarWidth: { ...N('sidebar', '栏宽', 160, 400), default: 250, group: "布局", unit: 'px' },
  sidebarTransparency: { ...N('sidebar', '透明度', 0, 1, 0.05), default: 1, group: "玻璃效果", percent: true, suffix: '%' },
  sidebarBlur: { ...N('sidebar', '模糊', 0, 40, 2), default: 0, group: "玻璃效果", unit: 'px', suffix: 'px' },
  sidebarTextColor: { ...C('sidebar', '文字颜色'), tier: 'basic', default: 'rgba(0,0,0,0.85)', group: "文字", },
  sidebarNameSize: { ...N('sidebar', '会话名字号', 11, 20), tier: 'basic', default: 14, group: "文字", unit: 'px' },
  // W2-10：侧栏平铺后无分组——字段保留兼容预设，不再注入 cssVar（防死注入）
  sidebarGroupSize: { ...N('sidebar', '分组标题字号', 10, 16), default: 12, group: "文字", unit: 'px', noCssVar: true, hidden: true },

  // ── chat ──
  chatBg: { ...C('chat', '背景色'), default: '', group: "背景", },
  chatBgImage: { ...T('chat', '背景图'), default: '', control: 'bgImage', group: "背景", },
  chatTransparency: { ...N('chat', '透明度', 0, 1, 0.05), default: 1, group: "背景", percent: true, suffix: '%' },
  chatBlur: { ...N('chat', '模糊', 0, 40, 2), default: 0, group: "背景", unit: 'px', suffix: 'px' },
  chatFont: { ...S('chat', '字体', ['mono', 'system']), default: 'mono', group: "字体", },
  chatFontSize: { ...N('chat', '字号', 12, 22), tier: 'basic', default: 15, group: "字体", unit: 'px' },
  chatLineHeight: { ...N('chat', '行高', 1.2, 2.5, 0.1), default: 1.4, group: "字体", },
  chatTextColor: { ...C('chat', '文字'), tier: 'basic', default: 'rgba(0,0,0,0.85)', group: "颜色", },
  chatCodeColor: { ...C('chat', '内联代码'), default: '#b47814', group: "颜色", },
  chatCodeBg: { ...C('chat', '代码背景'), default: 'rgba(0,0,0,0.03)', group: "颜色", },
  synKeyword: { ...C('chat', '语法·关键字'), default: '#b48ead', cssVar: '--syn-kw', group: "语法高亮", },
  synString: { ...C('chat', '语法·字符串'), default: '#96b5b4', cssVar: '--syn-str', group: "语法高亮", },
  synComment: { ...C('chat', '语法·注释'), default: '#65737e', cssVar: '--syn-cmt', group: "语法高亮", },
  synLiteral: { ...C('chat', '语法·数字'), default: '#d08770', cssVar: '--syn-lit', group: "语法高亮", },
  synEntity: { ...C('chat', '语法·类型'), default: '#ebcb8b', cssVar: '--syn-ent', group: "语法高亮", },
  synFunction: { ...C('chat', '语法·函数'), default: '#8fa1b3', cssVar: '--syn-fn', group: "语法高亮", },
  synVariable: { ...C('chat', '语法·变量'), default: '#c0c5ce', cssVar: '--syn-var', group: "语法高亮", },
  synProperty: { ...C('chat', '语法·属性'), default: '#c0c5ce', cssVar: '--syn-prop', group: "语法高亮", },
  synRegex: { ...C('chat', '语法·正则'), default: '#d08770', cssVar: '--syn-re', group: "语法高亮", },
  synMarkupHeading: { ...C('chat', '语法·标题'), default: '#65737e', cssVar: '--syn-mh', group: "语法高亮", },
  synCoReference: { ...C('chat', '语法·引用'), default: '#65737e', cssVar: '--syn-cor', hidden: true },
  synSupport: { ...C('chat', '语法·模块'), default: '#8fa1b3', cssVar: '--syn-support', group: "语法高亮", },
  toolOk: { ...C('chat', '工具·完成'), default: '#4EBA65', group: "指示器 & 连接线", },
  toolRun: { ...C('chat', '工具·运行中'), default: '#93A5FF', group: "指示器 & 连接线", },
  toolErr: { ...C('chat', '工具·错误'), default: '#FF6B80', group: "指示器 & 连接线", },
  userTagBg: { ...C('chat', '标签背景'), default: 'rgba(168,85,247,0.08)', group: "文字 & 标签", },
  userTagText: { ...C('chat', '标签文字'), default: '#a855f7', group: "文字 & 标签", },
  diffAdded: { ...C('chat', 'Diff·新增'), default: '#4EBA65', group: "Diff", },
  diffRemoved: { ...C('chat', 'Diff·删除'), default: '#FF6B80', group: "Diff", },
  diffAddedWord: { ...C('chat', 'Diff·词级新增'), default: '#3EA15E', group: "Diff", advanced: true },
  diffRemovedWord: { ...C('chat', 'Diff·词级删除'), default: '#E0556B', group: "Diff", advanced: true },
  // W2-01（F3-D/T4）：FileSheet 编辑器 8 字段预留（defs 先行、W2-04 消费；语法高亮复用 syn* 已有字段）
  editorFontSize: { ...N('chat', '编辑器字号', 10, 24), default: 13, group: "编辑器（FileSheet）", unit: 'px' },
  editorLineHeight: { ...N('chat', '编辑器行高', 1.2, 2.5, 0.1), default: 1.5, group: "编辑器（FileSheet）", },
  editorGutterColor: { ...C('chat', '行号文字'), default: '#65737e', group: "编辑器（FileSheet）", },
  editorGutterBg: { ...C('chat', '行号栏底色'), default: 'rgba(0,0,0,0.03)', group: "编辑器（FileSheet）", },
  editorSelection: { ...C('chat', '选中区背景'), default: 'rgba(59,130,246,0.25)', group: "编辑器（FileSheet）", },
  editorActiveLine: { ...C('chat', '当前行高亮'), default: 'rgba(0,0,0,0.04)', group: "编辑器（FileSheet）", },
  editorTabActive: { ...C('chat', '激活 Tab'), default: '#3b82f6', group: "编辑器（FileSheet）", },
  editorModifiedMark: { ...C('chat', '改动标记'), default: '#b47814', group: "编辑器（FileSheet）", },
  // toolIndicator 走 widgetRegistry 动态选项（toolIndicatorOptions），不进声明式 UI
  toolIndicator: { ...S('chat', '指示器形状', ['●', '■', '◆', '▶', '✦']), default: '●', hidden: true },
  // CSS 变量走 --pv-connector-*（ChatView 内联计算），字段不注入独立 var
  toolIndicatorGlow: { ...N('chat', '指示器辉光', 0, 20, 1), default: 0, group: "指示器 & 连接线", suffix: 'px', noCssVar: true },
  toolIndicatorGlowColor: { ...C('chat', '辉光色'), default: '', group: "指示器 & 连接线", noCssVar: true },
  toolConnectorMode: { ...S('chat', '连接线', ['none', 'fixed', 'follow']), default: 'none', group: "指示器 & 连接线", },
  toolConnectorColor: { ...C('chat', '连接线色'), default: 'rgba(0,0,0,0.12)', group: "指示器 & 连接线", showIf: t => t.toolConnectorMode === 'fixed' },
  toolConnectorStyle: { ...S('chat', '线样式', ['solid', 'dotted', 'pulse']), default: 'solid', group: "指示器 & 连接线", },
  toolConnectorWidth: { ...N('chat', '线宽', 1, 6), default: 2, group: "指示器 & 连接线", suffix: 'px' },
  toolConnectorOpacity: { ...N('chat', '线透明度', 0.1, 1, 0.05), default: 1, group: "指示器 & 连接线", percent: true, suffix: '%' },
  spinnerFramePreset: { ...S('chat', '动画预设', ['sparkles', 'ascii-line', 'braille', 'dots', 'orbit', 'clock', 'wave', 'blocks', 'scan', 'cc', 'custom']), tier: 'basic', default: 'sparkles', group: "Spinner", },
  spinnerCustomFrames: { ...T('chat', '自定义帧'), default: '', group: "Spinner", showIf: t => t.spinnerFramePreset === 'custom' },
  spinnerVerbSet: { ...S('chat', '文案语言', ['zh', 'en', 'analysis', 'engineering', 'cc', 'custom']), default: 'zh', group: "Spinner", },
  spinnerCustomVerbs: { ...T('chat', '自定义文案'), default: '', group: "Spinner", showIf: t => t.spinnerVerbSet === 'custom' },
  // CC stalled 渐变（3s 无响应后帧/文案趋向此色）；色值用户自定，不限定红
  spinnerStalledColor: { ...C('chat', '停滞颜色'), default: '#FF6B80', group: "Spinner", advanced: true, hint: '3s 无响应后 spinner 渐变趋向此色（CC 停滞反馈）' },
  spinnerDoneMarker: { ...T('chat', '完成标记'), default: '✓', control: 'spinnerMarker', group: "Spinner", },
  spinnerCancelledMarker: { ...T('chat', '取消标记'), default: '■', control: 'spinnerMarker', group: "Spinner", },
  spinnerErrorMarker: { ...T('chat', '错误标记'), default: '!', control: 'spinnerMarker', group: "Spinner", },
  // 模式已内嵌于 spinnerMarker 控件（SpinnerMarkerControl 的 frame/custom 下拉），独立行冗余 → hidden
  spinnerDoneMarkerMode: { ...S('chat', '完成标记模式', ['frame', 'custom']), default: 'custom', group: "Spinner", hidden: true },
  spinnerCancelledMarkerMode: { ...S('chat', '取消标记模式', ['frame', 'custom']), default: 'custom', group: "Spinner", hidden: true },
  spinnerErrorMarkerMode: { ...S('chat', '错误标记模式', ['frame', 'custom']), default: 'custom', group: "Spinner", hidden: true },
  // 动画间隔 JS 驱动（setInterval），无 CSS var 消费 → 不注入
  spinnerIntervalMs: { ...N('chat', '动画间隔', 40, 1000, 10), default: 120, group: "Spinner", suffix: 'ms', noCssVar: true },
  spinnerColor: { ...C('chat', 'Spinner 颜色'), tier: 'basic', default: '', group: "Spinner", },
  spinnerSize: { ...N('chat', 'Spinner 大小', 10, 32), default: 14, group: "Spinner", unit: 'px' },
  msgStyle: { ...S('chat', '消息风格', ['terminal', 'bubble']), default: 'terminal', group: "风格", },
  msgFont: { ...S('chat', '消息字体', ['mono', 'system']), default: 'mono', group: "风格", },
  // 经 App.tsx 手写 --msg-text 注入，自动派生 --msg-text-color 冗余 → 不注入
  msgTextColor: { ...C('chat', '消息文字'), tier: 'basic', default: '', group: "风格", noCssVar: true },
  msgLineHeight: { ...N('chat', '消息行距', 1.2, 2.5, 0.1), default: 1.8, group: "风格", },
  messageLayout: { ...S('chat', '信息层级', ['classic', 'claude', 'bubble']), default: 'classic', group: "风格", },
  // CC 视觉还原（claude 预设启用）：助手消息 ● 圆点
  assistantDot: { ...B('chat', '助手圆点'), default: false, group: "CC 风格" },
  assistantDotGlyph: { ...S('chat', '圆点形状', ['●', '■', '✦', '◆', '▶', '❯']), default: '●', group: "CC 风格" },
  assistantDotColor: { ...C('chat', '圆点颜色'), default: '', group: "CC 风格" },
  assistantDotImage: { ...T('chat', '头像/图标路径'), default: '', group: "CC 风格", hint: '留空用圆点字形；填本地图片路径或 URL 显示自定义头像（圆点列随图缩放）' },

  // ── cc ──
  ccHeight: {
    ...N('cc', '高度', 64, 400), default: 150,
    minFn: t => resolveCcMinHeight({
      inputMode: t.inputMode,
      footerLayout: t.footerLayout || 'free',
      hintMode: t.cliHintMode || 'full',
      visibleStatusWidgets: resolveVisibleStatusWidgetCount({
        hiddenIds: t.ccHidden || [],
        inputMode: t.inputMode,
        ccStyle: t.ccStyle || 'wave',
        submitButtonMode: t.inputSubmitButtonMode || 'inline',
      }),
      cliOverflowMode: t.cliOverflowMode || 'fixed-scroll',
    }),
  group: "外观风格",
  },
  ccBgHeight: { ...N('cc', '背景高度', 64, 400), default: 150, group: "中控背景", },
  ccBg: { ...C('cc', '背景色'), default: 'transparent', group: "外观风格", },
  ccBgImage: { ...T('cc', '背景图'), default: '', control: 'bgImage', group: "外观风格", },
  ccStatusFontSize: { ...N('cc', '信息字号', 14, 20), default: 14, group: "中控背景", unit: 'px' },
  ccStyle: { ...S('cc', '上下文', ['wave', 'bar', 'ring', 'numeric']), default: 'wave', group: "控件样式", },
  // 变体切换组件读 store 值（data-cc-variant），不注入 CSS var
  ccVariant: { ...S('cc', '整体风格', ['terminal', 'glass', 'pill']), default: 'terminal', group: "外观风格", noCssVar: true },
  ccLayout: H({ type: 'text', label: '布局', zone: 'cc', noCssVar: true }),
  ccHidden: H({ type: 'text', label: '隐藏控件', zone: 'cc', noCssVar: true }),
  ccScale: H({ type: 'text', label: '控件缩放', zone: 'cc', noCssVar: true }),
  inputBg: { ...C('cc', '输入背景'), default: 'rgba(0,0,0,0.02)', group: "输入与状态", },
  inputBgImage: { ...T('cc', '输入背景图'), default: '', control: 'bgImage', group: "输入与状态", },
  inputTextColor: { ...C('cc', '输入文字'), tier: 'basic', default: 'rgba(0,0,0,0.85)', group: "输入与状态", },
  inputPlaceholder: { ...C('cc', '占位符'), default: 'rgba(0,0,0,0.28)', group: "输入与状态", },
  inputSendBg: { ...C('cc', '发送按钮'), default: 'rgba(0,0,0,0.10)', group: "输入与状态", },
  inputFocusBorder: { ...C('cc', '焦点边框'), default: 'rgba(0,0,0,0.22)', group: "输入与状态", },
  inputFontSize: { ...N('cc', '输入字号', 12, 22), tier: 'basic', default: 17, group: "输入与状态", unit: 'px' },
  inputMinHeight: { ...N('cc', '输入最小高', 32, 120), default: 56, group: "输入与状态", unit: 'px', advanced: true },
  inputMode: { ...S('cc', '输入模式', ['cli', 'default']), default: 'cli', group: "输入与状态", },
  inputVariant: { ...S('cc', '输入栏', ['cli', 'composer', 'compact', 'command']), default: 'cli', syncOnChange: ['inputMode'], group: "控件样式", },
  inputShowPlaceholder: { ...S('cc', 'Placeholder', ['shown', 'hidden']), default: true, group: "控件样式", },
  inputShowHistoryHint: { ...S('cc', '历史提示', ['shown', 'hidden']), default: true, group: "控件样式", },
  inputSubmitButtonMode: { ...S('cc', '发送按钮', ['inline', 'external', 'hidden']), default: 'inline', group: "控件样式", },
  cliLineWidth: { ...N('cc', 'CLI 线宽', 1, 4), default: 2, group: "输入与状态", unit: 'px' },
  cliLineColor: { ...C('cc', 'CLI 线色'), default: '', group: "输入与状态", },
  cliTextColor: { ...C('cc', 'CLI 文字'), default: '', group: "输入与状态", },
  cliPromptColor: { ...C('cc', '提示符颜色'), default: '', group: "控件样式", },
  cliLinePadding: { ...N('cc', 'CLI 内边距', 0, 16), default: 6, group: "输入与状态", unit: 'px', advanced: true },
  cliContentOffsetY: { ...N('cc', '内容垂直偏移', -6, 6), default: 0, group: "控件样式", unit: 'px', advanced: true },
  cliHintMode: { ...S('cc', '命令提示', ['hidden', 'compact', 'full']), default: 'full', group: "控件样式", },
  footerLayout: { ...S('cc', 'Footer 布局', ['free', 'peri']), default: 'free', group: "控件样式", },
  cliOverflowMode: { ...S('cc', '多行策略', ['fixed-scroll', 'grow', 'overlay']), default: 'fixed-scroll', group: "控件样式", },
  statusBg: { ...C('cc', '状态背景'), default: 'transparent', group: "输入与状态", },
  statusBgImage: { ...T('cc', '状态背景图'), default: '', control: 'bgImage', group: "输入与状态", },
  // ekgWidth 注入 --ekg-w（StatusBar 消费）；动态波形未实现，动画细节字段已删除
  ekgWidth: { ...N('cc', '波形宽度', 60, 300), default: 150, group: "波形与用量", unit: 'px', cssVar: '--ekg-w' },
  // ekg/bar 三色与柱参数由 widgetRegistry 读 store 内联成 --bar-*/--ekg-*，注入独立 var 无消费
  ekgGreen: { ...C('cc', '波形·正常'), default: '#4EBA65', group: "波形与用量", },
  ekgYellow: { ...C('cc', '波形·警示'), default: '#FFC107', group: "波形与用量", noCssVar: true },
  ekgRed: { ...C('cc', '波形·危险'), default: '#FF6B80', group: "波形与用量", noCssVar: true },
  barTrackColor: { ...C('cc', '柱·轨道'), default: 'rgba(0,0,0,0.18)', group: "波形与用量", advanced: true, noCssVar: true },
  barFillColor: { ...C('cc', '柱·填充'), default: '#4EBA65', group: "波形与用量", advanced: true, noCssVar: true },
  barFillFollow: { ...B('cc', '柱·跟随用量'), default: true, group: "波形与用量", },
  barHeight: { ...N('cc', '柱高', 4, 24), default: 10, group: "波形与用量", advanced: true, noCssVar: true },
  pillBg: { ...C('cc', '胶囊背景'), default: '#373737', group: "波形与用量", },
  pillText: { ...C('cc', '胶囊文字'), default: '#999999', group: "波形与用量", },
  prismOnColor: { ...C('cc', 'Prism 开启'), default: '#4EBA65', group: "波形与用量", },
  modelVariant: { ...S('cc', '模型', ['dropdown', 'minimal', 'badge']), default: 'dropdown', group: "控件样式", },
  modeVariant: { ...S('cc', '模式', ['pill', 'badge', 'minimal']), default: 'pill', group: "控件样式", },
  sendVariant: { ...S('cc', '发送', ['icon', 'square', 'minimal']), default: 'icon', group: "控件样式", },
  attachVariant: { ...S('cc', '附件', ['icon', 'square', 'minimal']), default: 'icon', group: "控件样式", },
  modeAutoColor: { ...C('cc', '模式·auto'), default: '#FFC107', group: "控件样式", advanced: true },
  modeEditColor: { ...C('cc', '模式·edit'), default: '#A2A9E4', group: "控件样式", advanced: true },

  // ── right ──
  // W2-12：旧 RightPanel 退役——右栏背景字段保留兼容预设，不再注入 cssVar（防死注入）
  rightBg: { ...C('right', '背景色'), default: 'rgba(0,0,0,0.02)', group: "外观", noCssVar: true, hidden: true },
  rightBgImage: { ...T('right', '背景图'), default: '', control: 'bgImage', group: "外观", noCssVar: true, hidden: true },
  // W2-12：宽度经 App 计算 rightInset inline 应用，不注入 cssVar
  rightWidth: { ...N('right', '宽度', 200, 400), default: 260, group: "外观", unit: 'px', noCssVar: true },
  rightTransparency: { ...N('right', '透明度', 0, 1, 0.05), default: 1, group: "玻璃效果", percent: true, suffix: '%', noCssVar: true, hidden: true },
  rightBlur: { ...N('right', '模糊', 0, 40, 2), default: 0, group: "玻璃效果", unit: 'px', suffix: 'px', noCssVar: true, hidden: true },

  // ── META（持久化但非预设内容）──
  ccEditMode: { default: false, type: 'text', label: '编辑模式', zone: 'cc', noCssVar: true, hidden: true, meta: true },
  appliedPreset: { type: 'text', label: '活动预设', zone: 'global', noCssVar: true, hidden: true, meta: true },
  custom: { type: 'text', label: '脏标记', zone: 'global', noCssVar: true, hidden: true, meta: true },
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
export const GROUP_ORDER: Record<string, readonly { heading?: string; groups: readonly { title: string; compact?: boolean; defaultOpen?: boolean }[] }[]> = {
  global: [{ groups: [{ title: '个人信息' }, { title: '强调色' }, { title: '布局骨架' }, { title: '玻璃效果' }, { title: '字体' }] }],
  sidebar: [{ groups: [{ title: '背景' }, { title: '布局' }, { title: '玻璃效果' }, { title: '文字' }] }],
  chat: [
    // 高频组默认展开；低频组（语法高亮/Diff/CC 风格）默认折叠，搜索时强制展开
    { heading: '聊天区', groups: [{ title: '背景' }, { title: '字体' }, { title: '颜色', compact: true }, { title: '语法高亮', compact: true, defaultOpen: false }] },
    { heading: '工具调用', groups: [{ title: '指示器 & 连接线' }, { title: '文字 & 标签', compact: true }, { title: 'Diff', defaultOpen: false }, { title: 'Spinner' }] },
    { heading: '消息渲染', groups: [{ title: '风格', compact: true }, { title: 'CC 风格', defaultOpen: false }] },
  ],
  cc: [{ groups: [{ title: '外观风格' }, { title: '控件样式' }, { title: '输入与状态' }, { title: '波形与用量' }, { title: '中控背景', defaultOpen: false }] }],
  right: [{ groups: [{ title: '外观' }, { title: '玻璃效果' }] }],
}
/** W2-13（F3-A）：快速层基础字段清单（来自 defs 单一真值，组件不硬编码） */
export function resolveBasicThemeFields(): string[] {
  return THEME_FIELD_KEYS.filter(key => (THEME_FIELD_DEFS[key] as ThemeFieldDef).tier === 'basic')
}

export const THEME_DEFAULTS: Record<string, string | number | boolean> = Object.fromEntries(
  THEME_FIELD_KEYS
    .filter(key => (THEME_FIELD_DEFS[key] as ThemeFieldDef).default !== undefined)
    .map(key => [key, (THEME_FIELD_DEFS[key] as ThemeFieldDef).default as string | number | boolean]),
)

/**
 * defs 驱动的值归一化（声明式校验器）：
 * select 越枚举 → def.default；number 非有限/越界 → clamp 或 def.default；
 * boolean/color/text 类型不符 → def.default。
 */
export function normalizeThemeValue(def: ThemeFieldDef, value: unknown): string | number | boolean {
  switch (def.type) {
    case 'select':
      return (def.options ?? []).includes(value as string) ? (value as string) : (def.default as string ?? '')
    case 'number': {
      if (value === null || value === undefined) return (def.default as number) ?? 0
      const n = Number(value)
      if (!Number.isFinite(n)) return (def.default as number) ?? 0
      const min = def.min ?? -Infinity
      const max = def.max ?? Infinity
      return Math.min(max, Math.max(min, n))
    }
    case 'boolean':
      return typeof value === 'boolean' ? value : ((def.default as boolean) ?? false)
    case 'color':
    case 'text':
      return typeof value === 'string' ? value : (def.default as string ?? '')
  }
}

/**
 * 对持久化主题做全字段归一化（migrate 通用 pass）。
 * 跳过与 defs 类型不完全一致的历史字段（由调用方保留既有语义）：
 * - inputShowPlaceholder/inputShowHistoryHint：boolean 默认 + shown/hidden 枚举混用
 * - inputVariant：回退依赖 inputMode
 * - toolIndicator：有效值来自 widgetRegistry 动态选项（defs 仅是展示子集）
 */
export function normalizeThemeState<T extends Record<string, unknown>>(state: T): T {
  const next = { ...state } as Record<string, unknown>
  for (const key of THEME_FIELD_KEYS) {
    if (key === 'inputShowPlaceholder' || key === 'inputShowHistoryHint' || key === 'inputVariant' || key === 'toolIndicator') continue
    const def = THEME_FIELD_DEFS[key] as ThemeFieldDef
    if (def.default === undefined) continue
    if (next[key] === undefined) continue
    next[key] = normalizeThemeValue(def, next[key])
  }
  return next as T
}