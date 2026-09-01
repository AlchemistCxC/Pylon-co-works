import type { ThemeSettings } from './store'
import { resolveCcMinHeight, resolveVisibleStatusWidgetCount } from './ccHeightState.ts'
import type { FontRole } from './plugin-runtime/fonts/fontContributionTypes.ts'
import type { VisualSemanticRole } from './domains/theme/visualSemantics.ts'

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
  control?: 'default' | 'bgImage' | 'spinnerMarker' | 'schemeChip' | 'fontPicker' | 'segmented' | 'toolIndicator'
  /** Dynamic font registries may add stable ids beyond the built-in options. */
  allowCustomOptions?: boolean
  fontRole?: FontRole
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
  /** 设置 UI 的人类可读标签；持久化与 Skin schema 仍只使用稳定字符串值。 */
  optionLabels?: Readonly<Record<string, string>>
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
  /** DF-03b：该字段投影到的宿主视觉角色；角色名真值来自 visualSemantics。 */
  semanticRole?: VisualSemanticRole
  /** 该字段是公共角色的 preset/source 候选；其余同角色字段只投影自己的 zone alias。 */
  semanticSource?: boolean
}

const C = (zone: ZoneName, label: string): ThemeFieldDef => ({ type: 'color', label, zone })
const N = (zone: ZoneName, label: string, min?: number, max?: number, step?: number): ThemeFieldDef => ({ type: 'number', label, zone, min, max, step })
const S = (zone: ZoneName, label: string, options: readonly string[]): ThemeFieldDef => ({ type: 'select', label, zone, options })
const B = (zone: ZoneName, label: string): ThemeFieldDef => ({ type: 'boolean', label, zone })
const T = (zone: ZoneName, label: string): ThemeFieldDef => ({ type: 'text', label, zone })
const H = (def: ThemeFieldDef): ThemeFieldDef => ({ ...def, hidden: true })

const TOOL_INDICATOR_OPTION_IDS = [
  'circle', 'dot-small', 'ring', 'double-ring', 'diamond', 'square', 'triangle', 'play',
  'chevron', 'branch', 'node', 'hex', 'asterisk', 'star', 'check', 'cross', 'warning', 'plus', 'slash', 'hourglass',
] as const
const TOOL_INDICATOR_OPTION_LABELS: Readonly<Record<string, string>> = {
  circle: '● 圆点', 'dot-small': '· 小圆点', ring: '○ 圆环', 'double-ring': '◎ 双环', diamond: '◆ 菱形', square: '■ 方块',
  triangle: '▲ 三角', play: '▶ 播放', chevron: '› 尖括号', branch: '├ 分支', node: '◇ 节点', hex: '⬡ 六边形',
  asterisk: '✱ 星号', star: '★ 星标', check: '✓ 对勾', cross: '× 叉号', warning: '! 警告', plus: '+ 加号', slash: '╱ 斜杠', hourglass: '⧗ 沙漏',
}

export const THEME_FIELD_DEFS = {
  // ── global ──
  accent: { ...C('global', '强调色'), tier: 'basic', default: '#3b82f6', cssVar: '--accent', group: "强调色", hint: '链接、用户前缀、选中与焦点，以及等待动画光扫的统一取色', semanticRole: 'accent', semanticSource: true },
  transparency: { ...N('global', '背景不透明度', 0, 1, 0.05), default: 0.85, group: "玻璃效果", cssVar: '--t', percent: true, suffix: '%', hint: '只改变背景材质，不会让文字和控件一起变淡；设为 0 可透出桌面' },
  bgBlur: { ...N('global', '模糊', 0, 40, 2), default: 16, group: "玻璃效果", unit: 'px', cssVar: '--blur', suffix: 'px' },
  globalFont: { ...S('global', '界面字体', ['system', 'serif', 'mono']), optionLabels: {
    system: '系统无衬线', serif: '阅读衬线', mono: '等宽代码体',
  }, default: 'system', group: "字体", control: 'fontPicker', fontRole: 'interface', allowCustomOptions: true, hint: '应用导航、设置与普通界面的字体；代码和路径仍保留等宽体' },
  codeFont: { ...S('global', '代码与路径字体', ['mono']), optionLabels: { mono: 'JetBrains Mono' }, default: 'mono', group: "字体", control: 'fontPicker', fontRole: 'code', allowCustomOptions: true, hint: '代码、路径与终端输出专用；插件可以贡献新的等宽字体' },
  globalFontSize: { ...N('global', '基础字号', 12, 24), tier: 'basic', default: 18, group: "字体", unit: 'px' },
  globalBgImage: { ...T('global', '背景图'), default: '', control: 'bgImage', group: "玻璃效果", },
  globalBgColor: { ...C('global', '背景底色'), tier: 'basic', default: '#e8e8ec', group: "玻璃效果", hint: '背景图或透明材质下方使用的基础颜色', semanticRole: 'surface.canvas', semanticSource: true },
  uiScheme: { ...S('global', '界面明暗', ['light', 'dark']), tier: 'basic', default: 'light', group: "玻璃效果", control: 'schemeChip' },
  titlebarBg: { ...C('global', '标题栏背景'), default: '', group: '标题栏', cssVar: '--titlebar-bg', hint: '留空时跟随当前浅色/深色基础配色', semanticRole: 'surface.panel', semanticSource: true },
  titlebarTextColor: { ...C('global', '标题栏文字'), default: '', group: '标题栏', cssVar: '--titlebar-text', hint: '留空时跟随当前界面文字颜色', semanticRole: 'content.text' },
  userName: { ...T('global', '显示名'), default: '', group: "个人信息" },
  userPrefix: { ...T('global', '前缀'), default: '❯', group: "个人信息" },
  // ChatView 内联 style 应用（style={{color: userColor}}），不注入 CSS var
  userColor: { ...C('global', '名字颜色'), default: '', group: "个人信息", noCssVar: true },
  // 布局显隐并入 global zone（布局骨架组渲染在全局 tab），layout zone 无独立 tab/预设
  showTabBar: { ...B('global', '工作区标签栏'), default: true, group: "布局骨架" },
  showSidebar: { ...B('global', '左侧栏'), default: true, group: "布局骨架" },
  showPet: { ...B('global', '桌面宠物'), default: true, group: "布局骨架", hint: '隐藏工作区标签栏、左侧栏和宠物，可得到只保留聊天内容的单栏视图' },

  // ── sidebar ──
  sidebarBg: { ...C('sidebar', '侧栏背景色'), default: 'rgba(0,0,0,0.02)', group: "背景", semanticRole: 'surface.panel', semanticSource: true },
  sidebarBgImage: { ...T('sidebar', '侧栏背景图'), default: '', control: 'bgImage', group: "背景", },
  sidebarWidth: { ...N('sidebar', '左栏宽度', 160, 400), default: 250, group: "布局", unit: 'px' },
  sidebarTransparency: { ...N('sidebar', '侧栏背景不透明度', 0, 1, 0.05), default: 1, group: "玻璃效果", percent: true, suffix: '%' },
  sidebarBlur: { ...N('sidebar', '侧栏模糊', 0, 40, 2), default: 0, group: "玻璃效果", unit: 'px', suffix: 'px' },
  sidebarTextColor: { ...C('sidebar', '文字颜色'), tier: 'basic', default: 'rgba(0,0,0,0.85)', group: "文字", semanticRole: 'content.text' },
  sidebarNameSize: { ...N('sidebar', '会话名称字号', 11, 20), tier: 'basic', default: 14, group: "文字", unit: 'px' },
  // W2-10：侧栏平铺后无分组——字段保留兼容预设，不再注入 cssVar（防死注入）
  sidebarGroupSize: { ...N('sidebar', '分组标题字号', 10, 16), default: 12, group: "文字", unit: 'px', noCssVar: true, hidden: true },

  // ── chat ──
  chatBg: { ...C('chat', '消息流背景色'), default: '', group: "背景", semanticRole: 'surface.panel', semanticSource: true },
  chatBgImage: { ...T('chat', '消息流背景图'), default: '', control: 'bgImage', group: "背景", },
  chatTransparency: { ...N('chat', '消息流背景不透明度', 0, 1, 0.05), default: 1, group: "背景", percent: true, suffix: '%' },
  chatBlur: { ...N('chat', '消息流模糊', 0, 40, 2), default: 0, group: "背景", unit: 'px', suffix: 'px' },
  chatFont: { ...S('chat', '聊天区字体', ['mono', 'system', 'serif']), optionLabels: {
    mono: '终端等宽体', system: '系统无衬线', serif: '阅读衬线',
  }, default: 'mono', group: "字体", control: 'fontPicker', fontRole: 'content', allowCustomOptions: true, hint: '智能体聊天主区域使用的字体；代码块始终使用等宽体' },
  chatFontSize: { ...N('chat', '字号', 12, 22), tier: 'basic', default: 15, group: "字体", unit: 'px' },
  chatLineHeight: { ...N('chat', '行高', 1.2, 2.5, 0.1), default: 1.4, group: "字体", },
  chatTextColor: { ...C('chat', '文字'), tier: 'basic', default: 'rgba(0,0,0,0.85)', group: "颜色", semanticRole: 'content.text', semanticSource: true },
  chatCodeColor: { ...C('chat', '内联代码'), default: '#b47814', group: "颜色", },
  chatCodeBg: { ...C('chat', '代码背景'), default: 'rgba(0,0,0,0.03)', group: "颜色", },
  synKeyword: { ...C('chat', '关键字'), default: '#b48ead', cssVar: '--syn-kw', group: "语法高亮", },
  synString: { ...C('chat', '字符串'), default: '#96b5b4', cssVar: '--syn-str', group: "语法高亮", },
  synComment: { ...C('chat', '注释'), default: '#65737e', cssVar: '--syn-cmt', group: "语法高亮", },
  synLiteral: { ...C('chat', '数字与常量'), default: '#d08770', cssVar: '--syn-lit', group: "语法高亮", },
  synEntity: { ...C('chat', '类型与实体'), default: '#ebcb8b', cssVar: '--syn-ent', group: "语法高亮", },
  synFunction: { ...C('chat', '函数'), default: '#8fa1b3', cssVar: '--syn-fn', group: "语法高亮", },
  synVariable: { ...C('chat', '变量'), default: '#c0c5ce', cssVar: '--syn-var', group: "语法高亮", },
  synProperty: { ...C('chat', '属性'), default: '#c0c5ce', cssVar: '--syn-prop', group: "语法高亮", },
  synRegex: { ...C('chat', '正则表达式'), default: '#d08770', cssVar: '--syn-re', group: "语法高亮", },
  synMarkupHeading: { ...C('chat', '文档标题'), default: '#65737e', cssVar: '--syn-mh', group: "语法高亮", },
  synCoReference: { ...C('chat', '语法·引用'), default: '#65737e', cssVar: '--syn-cor', hidden: true },
  synSupport: { ...C('chat', '模块与支持项'), default: '#8fa1b3', cssVar: '--syn-support', group: "语法高亮", },
  toolOk: { ...C('chat', '工具完成状态'), default: '#4EBA65', group: "指示器与连接线", semanticRole: 'state.success', semanticSource: true },
  toolRun: { ...C('chat', '工具运行状态'), default: '#93A5FF', group: "指示器与连接线", semanticRole: 'accent' },
  toolErr: { ...C('chat', '工具错误状态'), default: '#FF6B80', group: "指示器与连接线", semanticRole: 'state.danger', semanticSource: true },
  userTagBg: { ...C('chat', '用户标签背景'), default: 'rgba(168,85,247,0.08)', group: "用户标签", },
  userTagText: { ...C('chat', '用户标签文字'), default: '#a855f7', group: "用户标签", },
  diffAdded: { ...C('chat', '新增行'), default: '#4EBA65', group: "代码差异", semanticRole: 'state.success' },
  diffRemoved: { ...C('chat', '删除行'), default: '#FF6B80', group: "代码差异", semanticRole: 'state.danger' },
  diffAddedWord: { ...C('chat', '行内新增片段'), default: '#3EA15E', group: "代码差异", advanced: true },
  diffRemovedWord: { ...C('chat', '行内删除片段'), default: '#E0556B', group: "代码差异", advanced: true },
  // W2-01（F3-D/T4）：FileSheet 编辑器 8 字段预留（defs 先行、W2-04 消费；语法高亮复用 syn* 已有字段）
  editorFontSize: { ...N('chat', '编辑器字号', 10, 24), default: 13, group: "文件编辑器", unit: 'px' },
  editorLineHeight: { ...N('chat', '编辑器行高', 1.2, 2.5, 0.1), default: 1.5, group: "文件编辑器", },
  editorGutterColor: { ...C('chat', '行号文字'), default: '#65737e', group: "文件编辑器", },
  editorGutterBg: { ...C('chat', '行号栏底色'), default: 'rgba(0,0,0,0.03)', group: "文件编辑器", },
  editorSelection: { ...C('chat', '选中区背景'), default: 'rgba(59,130,246,0.25)', group: "文件编辑器", },
  editorActiveLine: { ...C('chat', '当前行高亮'), default: 'rgba(0,0,0,0.04)', group: "文件编辑器", },
  editorTabActive: { ...C('chat', '活动文件标签'), default: '#3b82f6', group: "文件编辑器", semanticRole: 'accent' },
  editorModifiedMark: { ...C('chat', '改动标记'), default: '#b47814', group: "文件编辑器", semanticRole: 'state.warning' },
  // toolIndicator 候选由 toolIndicatorOptions 单一真值提供；静态 options 仅供 schema/旧值归一化参考。
  toolIndicator: { ...S('chat', '兼容回退指示器', ['●', '■', '◆', '▶', '✦']), default: '●', control: 'toolIndicator', group: "指示器与连接线", hidden: true },
  // 三态独立字形：运行/完成/失败不再共享一个 glyph。值使用
  // toolIndicatorAssets 的稳定 id，旧的 toolIndicator 仍作为回退。
  toolIndicatorRun: { ...S('chat', '运行中指示器', TOOL_INDICATOR_OPTION_IDS), optionLabels: TOOL_INDICATOR_OPTION_LABELS, default: 'circle', control: 'toolIndicator', group: "指示器与连接线" },
  toolIndicatorOk: { ...S('chat', '完成时指示器', TOOL_INDICATOR_OPTION_IDS), optionLabels: TOOL_INDICATOR_OPTION_LABELS, default: 'check', control: 'toolIndicator', group: "指示器与连接线" },
  toolIndicatorErr: { ...S('chat', '失败时指示器', TOOL_INDICATOR_OPTION_IDS), optionLabels: TOOL_INDICATOR_OPTION_LABELS, default: 'cross', control: 'toolIndicator', group: "指示器与连接线" },
  // CSS 变量走 --pv-connector-*（ChatView 内联计算），字段不注入独立 var
  toolIndicatorGlow: { ...N('chat', '指示器光晕', 0, 20, 1), default: 0, group: "指示器与连接线", suffix: 'px', noCssVar: true },
  toolIndicatorGlowColor: { ...C('chat', '光晕颜色'), default: '', group: "指示器与连接线", noCssVar: true },
  toolConnectorMode: { ...S('chat', '连接线显示', ['none', 'fixed', 'follow']), optionLabels: { none: '关闭', fixed: '固定轨道', follow: '跟随工具' }, default: 'none', group: "指示器与连接线", },
  toolConnectorColor: { ...C('chat', '连接线颜色'), default: 'rgba(0,0,0,0.12)', group: "指示器与连接线", showIf: t => t.toolConnectorMode === 'fixed', semanticRole: 'connector.default', semanticSource: true },
  toolConnectorStyle: { ...S('chat', '连接线样式', ['solid', 'dotted', 'pulse']), optionLabels: { solid: '实线', dotted: '点线', pulse: '流动脉冲' }, default: 'solid', group: "指示器与连接线", },
  toolConnectorWidth: { ...N('chat', '连接线宽度', 1, 6), default: 2, group: "指示器与连接线", suffix: 'px' },
  toolConnectorOpacity: { ...N('chat', '连接线不透明度', 0.1, 1, 0.05), default: 1, group: "指示器与连接线", percent: true, suffix: '%' },
  spinnerFramePreset: { ...S('chat', '动画预设', ['sparkles', 'ascii-line', 'braille', 'dots', 'orbit', 'clock', 'wave', 'blocks', 'scan', 'cc', 'custom']), optionLabels: { sparkles: '星芒', 'ascii-line': 'ASCII 线', braille: '盲文流', dots: '圆点', orbit: '轨道', clock: '时钟', wave: '波形', blocks: '方块', scan: '扫描', cc: 'Claude Code', custom: '自定义' }, tier: 'basic', default: 'sparkles', group: "等待动画", },
  spinnerCustomFrames: { ...T('chat', '自定义动画帧'), default: '', group: "等待动画", showIf: t => t.spinnerFramePreset === 'custom' },
  spinnerVerbSet: { ...S('chat', '状态文案风格', ['zh', 'en', 'analysis', 'engineering', 'cc', 'custom']), optionLabels: { zh: '中文通用', en: '英文通用', analysis: '分析过程', engineering: '工程任务', cc: 'Claude Code', custom: '自定义' }, default: 'zh', group: "等待动画", },
  spinnerCustomVerbs: { ...T('chat', '自定义状态文案'), default: '', group: "等待动画", showIf: t => t.spinnerVerbSet === 'custom' },
  // CC stalled 渐变（3s 无响应后帧/文案趋向此色）；色值用户自定，不限定红
  spinnerStalledColor: { ...C('chat', '长时间等待颜色'), default: '#FF6B80', group: "等待动画", advanced: true, hint: '连续 3 秒没有新响应时，等待动画会渐变到此颜色', semanticRole: 'state.danger' },
  spinnerDoneMarker: { ...T('chat', '完成标记'), default: '✓', control: 'spinnerMarker', group: "等待动画", },
  spinnerCancelledMarker: { ...T('chat', '取消标记'), default: '■', control: 'spinnerMarker', group: "等待动画", },
  spinnerErrorMarker: { ...T('chat', '错误标记'), default: '!', control: 'spinnerMarker', group: "等待动画", },
  // 模式已内嵌于 spinnerMarker 控件（SpinnerMarkerControl 的 frame/custom 下拉），独立行冗余 → hidden
  spinnerDoneMarkerMode: { ...S('chat', '完成标记模式', ['frame', 'custom']), default: 'custom', group: "等待动画", hidden: true },
  spinnerCancelledMarkerMode: { ...S('chat', '取消标记模式', ['frame', 'custom']), default: 'custom', group: "等待动画", hidden: true },
  spinnerErrorMarkerMode: { ...S('chat', '错误标记模式', ['frame', 'custom']), default: 'custom', group: "等待动画", hidden: true },
  // 动画间隔 JS 驱动（setInterval），无 CSS var 消费 → 不注入
  spinnerIntervalMs: { ...N('chat', '动画帧间隔', 40, 1000, 10), default: 120, group: "等待动画", suffix: 'ms', noCssVar: true },
  spinnerColor: { ...C('chat', '等待动画颜色'), tier: 'basic', default: '', group: "等待动画", semanticRole: 'accent' },
  spinnerSize: { ...N('chat', '等待动画大小', 10, 32), default: 14, group: "等待动画", unit: 'px' },
  msgStyle: { ...S('chat', '消息风格', ['terminal', 'bubble']), optionLabels: { terminal: '终端记录流', bubble: '对话气泡' }, default: 'terminal', control: 'segmented', group: "风格", },
  msgFont: { ...S('chat', '正文渲染字体', ['mono', 'system', 'serif']), optionLabels: {
    mono: '跟随终端等宽体', system: '系统无衬线', serif: '阅读衬线',
  }, default: 'mono', group: "风格", control: 'fontPicker', fontRole: 'content', allowCustomOptions: true, hint: 'Markdown 正文的渲染字体，不影响内联代码与代码块' },
  // 经 App.tsx 手写 --msg-text 注入，自动派生 --msg-text-color 冗余 → 不注入
  msgTextColor: { ...C('chat', '消息文字'), tier: 'basic', default: '', group: "风格", noCssVar: true, semanticRole: 'content.text' },
  msgLineHeight: { ...N('chat', '消息行距', 1.2, 2.5, 0.1), default: 1.8, group: "风格", },
  messageLayout: { ...S('chat', '消息布局', ['classic', 'claude', 'bubble']), optionLabels: { classic: '经典紧凑', claude: '阅读记录', bubble: '对话气泡' }, default: 'classic', control: 'segmented', group: "风格", },
  messageUserBg: { ...C('chat', '用户消息背景'), default: '', group: "消息外观", },
  messageAssistantBg: { ...C('chat', '助手消息背景'), default: '', group: "消息外观", },
  messageReasoningBg: { ...C('chat', '思考过程背景'), default: '', group: "消息外观", },
  messageBorderColor: { ...C('chat', '消息边框'), default: '', group: "消息外观", semanticRole: 'stroke.default', semanticSource: true },
  messageRadius: { ...N('chat', '消息圆角', 0, 28), default: 0, group: "消息外观", unit: 'px', suffix: 'px' },
  // CC 视觉还原（claude 预设启用）：助手消息 ● 圆点
  assistantDot: { ...B('chat', '显示助手消息标记'), default: false, group: "助手标记" },
  assistantDotGlyph: { ...S('chat', '标记图案', ['●', '■', '✦', '◆', '▶', '❯']), default: '●', group: "助手标记" },
  assistantDotColor: { ...C('chat', '标记颜色'), default: '', group: "助手标记", semanticRole: 'accent' },
  assistantDotImage: { ...T('chat', '自定义头像或图标'), default: '', control: 'bgImage', group: "助手标记", hint: '留空时使用上方图案；也可填写本地图片路径或网络图片地址' },

  // ── cc ──
  ccHeight: {
    ...N('cc', '中控区高度', 64, 400), default: 150,
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
  ccBgHeight: { ...N('cc', '背景层高度', 64, 400), default: 150, group: "状态信息", },
  ccBg: { ...C('cc', '中控区背景'), default: 'transparent', group: "外观风格", semanticRole: 'surface.panel', semanticSource: true },
  ccBgImage: { ...T('cc', '中控区背景图'), default: '', control: 'bgImage', group: "外观风格", },
  ccStatusFontSize: { ...N('cc', '状态信息字号', 14, 20), default: 16, group: "状态信息", unit: 'px' },
  ccStyle: { ...S('cc', '用量显示方式', ['wave', 'bar', 'ring', 'numeric']), optionLabels: { wave: '活动波形', bar: '用量进度条', ring: '环形进度', numeric: '百分比数值' }, default: 'wave', group: "控件样式", },
  // 变体切换组件读 store 值（data-cc-variant），不注入 CSS var
  ccVariant: { ...S('cc', '整体风格', ['terminal', 'glass', 'pill']), optionLabels: { terminal: '终端状态栏', glass: '玻璃工作台', pill: '轻量胶囊' }, default: 'terminal', group: "外观风格", noCssVar: true },
  ccLayout: H({ type: 'text', label: '布局', zone: 'cc', noCssVar: true }),
  ccHidden: H({ type: 'text', label: '隐藏控件', zone: 'cc', noCssVar: true }),
  ccScale: H({ type: 'text', label: '控件缩放', zone: 'cc', noCssVar: true }),
  inputBg: { ...C('cc', '输入背景'), default: 'rgba(0,0,0,0.02)', group: "输入与状态", semanticRole: 'surface.raised', semanticSource: true },
  inputBgImage: { ...T('cc', '输入背景图'), default: '', control: 'bgImage', group: "输入与状态", },
  inputTextColor: { ...C('cc', '输入文字'), tier: 'basic', default: 'rgba(0,0,0,0.85)', group: "输入与状态", semanticRole: 'content.text' },
  inputPlaceholder: { ...C('cc', '占位提示颜色'), default: 'rgba(0,0,0,0.28)', group: "输入与状态", semanticRole: 'content.muted' },
  inputSendBg: { ...C('cc', '发送按钮背景'), default: 'rgba(0,0,0,0.10)', group: "输入与状态", semanticRole: 'surface.raised' },
  inputBorderColor: { ...C('cc', '输入边框'), default: '', group: "输入与状态", semanticRole: 'stroke.default', semanticSource: true },
  inputFocusBorder: { ...C('cc', '焦点边框'), default: 'rgba(0,0,0,0.22)', group: "输入与状态", semanticRole: 'state.focusRing', semanticSource: true },
  inputRadius: { ...N('cc', '输入栏圆角', 0, 28), default: 0, group: "输入与状态", unit: 'px', suffix: 'px' },
  inputFocusRingWidth: { ...N('cc', '焦点光环', 0, 8), default: 0, group: "输入与状态", unit: 'px', suffix: 'px', advanced: true },
  inputFontSize: { ...N('cc', '输入字号', 12, 22), tier: 'basic', default: 17, group: "输入与状态", unit: 'px' },
  inputMinHeight: { ...N('cc', '输入栏最小高度', 32, 120), default: 56, group: "输入与状态", unit: 'px', advanced: true },
  inputMode: { ...S('cc', '输入交互模式', ['cli', 'default']), optionLabels: { cli: '命令行交互', default: '标准输入' }, default: 'cli', control: 'segmented', group: "输入与状态", },
  inputVariant: { ...S('cc', '输入栏外观', ['cli', 'composer', 'compact', 'command']), optionLabels: { cli: '命令行', composer: '标准编辑器', compact: '紧凑输入', command: '命令面板' }, default: 'cli', syncOnChange: ['inputMode'], group: "控件样式", },
  inputShowPlaceholder: { ...S('cc', '显示输入提示', ['shown', 'hidden']), optionLabels: { shown: '显示', hidden: '隐藏' }, default: true, group: "控件样式", },
  inputShowHistoryHint: { ...S('cc', '显示历史快捷提示', ['shown', 'hidden']), optionLabels: { shown: '显示', hidden: '隐藏' }, default: true, group: "控件样式", },
  inputSubmitButtonMode: { ...S('cc', '发送按钮位置', ['inline', 'external', 'hidden']), optionLabels: { inline: '输入栏内', external: '独立按钮', hidden: '隐藏' }, default: 'inline', group: "控件样式", },
  cliLineWidth: { ...N('cc', '命令行边框宽度', 1, 4), default: 2, group: "输入与状态", unit: 'px' },
  cliLineColor: { ...C('cc', '命令行边框颜色'), default: '', group: "输入与状态", semanticRole: 'connector.default' },
  cliTextColor: { ...C('cc', '命令行文字颜色'), default: '', group: "输入与状态", semanticRole: 'content.text' },
  cliPromptColor: { ...C('cc', '提示符颜色'), default: '', group: "控件样式", semanticRole: 'accent' },
  cliLinePadding: { ...N('cc', '命令行内边距', 0, 16), default: 6, group: "输入与状态", unit: 'px', advanced: true },
  cliContentOffsetY: { ...N('cc', '内容垂直偏移', -6, 6), default: 0, group: "控件样式", unit: 'px', advanced: true },
  cliHintMode: { ...S('cc', '快捷提示详细程度', ['hidden', 'compact', 'full']), optionLabels: { hidden: '隐藏', compact: '仅常用项', full: '显示全部' }, default: 'full', group: "控件样式", },
  footerLayout: { ...S('cc', '底部信息布局', ['free', 'peri']), optionLabels: { free: '独立状态行', peri: '输入栏下方' }, default: 'free', group: "控件样式", },
  cliOverflowMode: { ...S('cc', '多行输入行为', ['fixed-scroll', 'grow', 'overlay']), optionLabels: { 'fixed-scroll': '固定高度并滚动', grow: '随内容增高', overlay: '浮层展开' }, default: 'fixed-scroll', group: "控件样式", },
  statusBg: { ...C('cc', '状态区背景'), default: 'transparent', group: "输入与状态", semanticRole: 'surface.panel', semanticSource: true },
  statusBgImage: { ...T('cc', '状态区背景图'), default: '', control: 'bgImage', group: "输入与状态", },
  // ekgWidth 注入 --ekg-w（StatusBar 消费）；动态波形未实现，动画细节字段已删除
  ekgWidth: { ...N('cc', '波形宽度', 60, 300), default: 150, group: "波形与用量", unit: 'px', cssVar: '--ekg-w' },
  // ekg/bar 三色与柱参数由 widgetRegistry 读 store 内联成 --bar-*/--ekg-*，注入独立 var 无消费
  ekgGreen: { ...C('cc', '活动波形正常状态'), default: '#4EBA65', group: "波形与用量", semanticRole: 'state.success' },
  ekgYellow: { ...C('cc', '活动波形警示状态'), default: '#FFC107', group: "波形与用量", noCssVar: true, semanticRole: 'state.warning', semanticSource: true },
  ekgRed: { ...C('cc', '活动波形危险状态'), default: '#FF6B80', group: "波形与用量", noCssVar: true, semanticRole: 'state.danger' },
  barTrackColor: { ...C('cc', '用量条轨道'), default: 'rgba(0,0,0,0.18)', group: "波形与用量", advanced: true, noCssVar: true, semanticRole: 'stroke.default' },
  barFillColor: { ...C('cc', '用量条填充'), default: '#4EBA65', group: "波形与用量", advanced: true, noCssVar: true, semanticRole: 'state.success' },
  barFillFollow: { ...B('cc', '填充色跟随用量'), default: true, group: "波形与用量", },
  barHeight: { ...N('cc', '用量条高度', 4, 24), default: 10, group: "波形与用量", advanced: true, noCssVar: true },
  pillBg: { ...C('cc', '用量胶囊背景'), default: '#373737', group: "波形与用量", semanticRole: 'surface.raised' },
  pillText: { ...C('cc', '用量胶囊文字'), default: '#999999', group: "波形与用量", semanticRole: 'content.text' },
  prismOnColor: { ...C('cc', 'Prism 已开启状态'), default: '#4EBA65', group: "波形与用量", semanticRole: 'state.success' },
  modelVariant: { ...S('cc', '模型控件外观', ['dropdown', 'minimal', 'badge']), optionLabels: { dropdown: '下拉选择', minimal: '极简文字', badge: '徽标' }, default: 'dropdown', group: "控件样式", },
  modeVariant: { ...S('cc', '模式控件外观', ['pill', 'badge', 'minimal']), optionLabels: { pill: '胶囊', badge: '方括号', minimal: '极简文字' }, default: 'pill', group: "控件样式", },
  sendVariant: { ...S('cc', '发送按钮外观', ['icon', 'square', 'minimal']), optionLabels: { icon: '圆形图标', square: '方形按钮', minimal: '极简图标' }, default: 'icon', group: "控件样式", },
  attachVariant: { ...S('cc', '附件按钮外观', ['icon', 'square', 'minimal']), optionLabels: { icon: '圆形图标', square: '方形按钮', minimal: '极简图标' }, default: 'icon', group: "控件样式", },
  modeAutoColor: { ...C('cc', '自动模式颜色'), default: '#FFC107', group: "控件样式", advanced: true, semanticRole: 'state.warning' },
  modeEditColor: { ...C('cc', '编辑模式颜色'), default: '#A2A9E4', group: "控件样式", advanced: true, semanticRole: 'accent' },

  // ── right ──
  rightBg: { ...C('right', '右栏背景色'), default: 'rgba(0,0,0,0.02)', group: "外观", semanticRole: 'surface.panel', semanticSource: true },
  rightBgImage: { ...T('right', '右栏背景图'), default: '', control: 'bgImage', group: "外观" },
  // W2-12：宽度经 App 计算 rightInset inline 应用，不注入 cssVar
  // 已迁移到应用级 rightRailStore；保留字段仅供旧主题读取，不再在设置页渲染。
  rightWidth: { ...N('right', '右栏宽度', 200, 400), default: 260, group: "外观", unit: 'px', noCssVar: true, hidden: true, hint: '已迁移到标题栏右侧栏的拖拽布局' },
  rightTransparency: { ...N('right', '右栏背景不透明度', 0, 1, 0.05), default: 1, group: "玻璃效果", percent: true, suffix: '%' },
  rightBlur: { ...N('right', '右栏模糊', 0, 40, 2), default: 0, group: "玻璃效果", unit: 'px', suffix: 'px' },

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
  global: [{ groups: [{ title: '个人信息' }, { title: '强调色' }, { title: '布局骨架' }, { title: '玻璃效果' }, { title: '标题栏' }, { title: '字体' }] }],
  sidebar: [{ groups: [{ title: '背景' }, { title: '布局' }, { title: '玻璃效果' }, { title: '文字' }] }],
  chat: [
    // 高频组默认展开；低频组（语法高亮/代码差异/助手标记）默认折叠，搜索时强制展开
    { heading: '聊天区', groups: [{ title: '背景' }, { title: '字体' }, { title: '颜色', compact: true }, { title: '语法高亮', compact: true, defaultOpen: false }] },
    { heading: '工具调用', groups: [{ title: '指示器与连接线' }, { title: '用户标签', compact: true }, { title: '代码差异', defaultOpen: false }, { title: '等待动画' }] },
    { heading: '消息渲染', groups: [{ title: '风格', compact: true }, { title: '消息外观', compact: true }, { title: '助手标记', defaultOpen: false }, { title: '文件编辑器', defaultOpen: false }] },
  ],
  cc: [{ groups: [{ title: '外观风格' }, { title: '控件样式' }, { title: '输入与状态' }, { title: '波形与用量' }, { title: '状态信息', defaultOpen: false }] }],
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
      if (def.allowCustomOptions && typeof value === 'string' && value.trim()) return value
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
    // 持久化 select 可能来自运行时插件候选项；水合时插件 Registry 尚未激活，
    // 不得因静态 options 暂时不包含该值就悄悄改回默认。Presentation Profile
    // 注册仍直接调用 normalizeThemeValue，继续使用严格静态校验。
    if (def.type === 'select' && typeof next[key] === 'string' && next[key].trim()) continue
    next[key] = normalizeThemeValue(def, next[key])
  }
  return next as T
}
