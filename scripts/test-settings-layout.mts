import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const defs = read('../src/themeFieldDefs.ts')
const renderer = read('../src/themeFieldRenderer.tsx')
const settings = read('../src/components/Settings.tsx')
const store = read('../src/store.ts')

// ── 低频组默认折叠 + 组粒度合并 ──
assert.match(defs, /defaultOpen: false/, '低频组必须声明默认折叠')
assert.match(defs, /\{ title: '语法高亮', compact: true, defaultOpen: false \}/, '语法高亮组默认折叠')
assert.match(defs, /\{ title: 'Diff', defaultOpen: false \}/, 'Diff 组默认折叠')
assert.match(defs, /\{ title: 'CC 风格', defaultOpen: false \}/, 'CC 风格组默认折叠')
assert.match(defs, /\{ title: '中控背景', defaultOpen: false \}/, '中控背景组默认折叠')
// 背景+玻璃效果合并：chatTransparency/chatBlur 归入"背景"
assert.match(defs, /chatTransparency: \{[\s\S]*?group: "背景"/, '透明度并入背景组')
assert.match(defs, /chatBlur: \{[\s\S]*?group: "背景"/, '模糊并入背景组')
// 指示器+连接线合并：工具三色归入"指示器 & 连接线"
assert.match(defs, /toolOk: \{[\s\S]*?group: "指示器 & 连接线"/, '工具·完成并入指示器&连接线')
assert.match(defs, /toolRun: \{[\s\S]*?group: "指示器 & 连接线"/, '工具·运行中并入指示器&连接线')
assert.match(defs, /toolErr: \{[\s\S]*?group: "指示器 & 连接线"/, '工具·错误并入指示器&连接线')
assert.doesNotMatch(defs, /\{ title: '指示器', compact: true \}/, 'chat 区不得再有独立"指示器"组')
const chatOrder = defs.match(/chat: \[([\s\S]*?)\],\n  cc:/)?.[1] ?? ''
assert.ok(chatOrder.length > 0, '必须能截取 chat GROUP_ORDER 数组')
assert.doesNotMatch(chatOrder, /玻璃效果/, 'chat 区不得再有独立"玻璃效果"组')

// ── 渲染器：search 过滤 + defaultOpen/forceOpen + 搜索时 advanced 内联 ──
assert.match(renderer, /search\?: string/, 'RenderCtx 必须支持 search')
assert.match(renderer, /function Group\(\{ title, children, defaultOpen, forceOpen \}/, 'Group 必须支持 defaultOpen/forceOpen')
assert.match(renderer, /def\.label\.toLowerCase\(\)\.includes\(query\)/, '字段必须按 label 过滤')
assert.match(renderer, /defaultOpen=\{group\.defaultOpen\} forceOpen=\{searching\}/, '搜索时强制展开折叠组')
assert.match(renderer, /const searching = \(ctx\.search\?\.trim\(\) \?\? ''\)\.length > 0[\s\S]*?searching[\s\S]*?\? advancedRows/, '搜索时 advanced 字段内联展开')

// ── Settings：工具栏（搜索 + 重置本区）+ nav dirty 圆点 ──
assert.match(settings, /className="set-search"/, '设置页必须有搜索输入框')
assert.match(settings, /set-zone-reset/, '必须有重置本区按钮')
assert.match(settings, /resetZone\(TAB_ZONE_MAP\[activeTab\]/, '重置本区必须接线到 store.resetZone')
assert.match(settings, /\$\{dirty\[TAB_ZONE_MAP\[tab\]\] \? ' dirty' : ''\}/, '导航按钮必须显示 dirty 圆点')
assert.match(settings, /const isSearching = searchQuery\.trim\(\)\.length > 0/, '搜索状态必须驱动手写组隐藏')

// ── store：resetZone 只重置标量主题字段 ──
assert.match(store, /resetZone: \(zone\) => set\(state => \{/, 'store 必须实现 resetZone')
assert.match(store, /ZONE_FIELDS\[zone\]/, 'resetZone 必须按 zone 字段表重置')
assert.match(store, /typeof value === 'string' \|\| typeof value === 'number' \|\| typeof value === 'boolean'/, 'resetZone 必须只重置标量（不碰 ccLayout/ccHidden/ccScale）')
assert.match(store, /activePreset: \{ \.\.\.state\.activePreset, \[zone\]: '' \}/, 'resetZone 必须清 activePreset[zone]')
assert.match(store, /dirty: \{ \.\.\.state\.dirty, \[zone\]: false \}/, 'resetZone 必须清 dirty[zone]')

// ── 停滞颜色标签中性化 ──
assert.match(defs, /spinnerStalledColor: \{[\s\S]*?'停滞颜色'/, '停滞字段不得再叫"停滞变红色"')
assert.doesNotMatch(defs, /'停滞变红色'/, '旧标签"停滞变红色"必须移除')

// ── 骨架：default 进 defs + THEME_DEFAULTS 派生 ──
assert.match(defs, /default\?: string \| number \| boolean/, 'ThemeFieldDef 必须声明 default')
assert.match(defs, /export const THEME_DEFAULTS[\s\S]*THEME_FIELD_DEFS\[key\][\s\S]*?\.default/, 'THEME_DEFAULTS 必须由 defs 派生')
assert.match(defs, /ccLayout[\s\S]*?(?:\n|$)[\s\S]*?ccEditMode: \{[\s\S]*?default: false/, 'ccEditMode 必须有默认值')
assert.doesNotMatch(defs, /export const THEME_DEFAULTS[\s\S]*?=\s*\{\s*\n  accent:/, 'THEME_DEFAULTS 不得再是手工对象字面量')

// ── 骨架：声明式校验器（normalizeThemeValue/normalizeThemeState）──
assert.match(defs, /export function normalizeThemeValue\(/, '必须有 defs 驱动的值归一化')
assert.match(defs, /export function normalizeThemeState</, '必须有全字段归一化')
assert.match(defs, /key === 'toolIndicator'/, 'normalizeThemeState 必须跳过 registry 动态选项字段')
assert.match(store, /normalizeThemeState\(state\)/, 'migrate 必须调用 defs 驱动的归一化')
assert.match(store, /normalizeThemeState\(pickCustomPresetTheme/, 'applyCustomPreset 必须防御性归一化')

// ── 骨架：字段级恢复默认 ──
assert.match(renderer, /set-field-reset/, '字段级恢复默认按钮必须存在')
assert.match(renderer, /Object\.is\(value, def\.default\)/, '恢复默认判定必须比对 defs default')

// ── 死字段清理：动态波形未实现，7 个动画细节字段必须删除；ekgWidth 走 --ekg-w ──
for (const dead of ['ekgFontSize', 'ekgLineWidth', 'ekgAmplitudeMax', 'ekgSpeedBase', 'ekgSpeedMax', 'ekgLeftColor', 'ekgMovingColor']) {
  assert.doesNotMatch(defs, new RegExp(`\\b${dead}\\b`), `死字段 ${dead} 必须从 defs 删除`)
  assert.doesNotMatch(store, new RegExp(`\\b${dead}\\b`), `死字段 ${dead} 必须从 ThemeSettings 删除`)
}
assert.match(defs, /ekgWidth: \{[\s\S]*?cssVar: '--ekg-w'/, 'ekgWidth 必须注入 --ekg-w（StatusBar 消费）')
assert.match(store, /ekgConsumedColor: string; tokenDisplay: string/, 'ekgConsumedColor/tokenDisplay 保留')
assert.doesNotMatch(store, /ekgLeftColor: string; ekgMovingColor/, 'store 不得残留 ekgLeftColor/ekgMovingColor')

// ── 骨架：手写组声明式化（个人信息/强调色/布局骨架进 defs）──
assert.match(defs, /userName: \{[\s\S]*?group: "个人信息"/, '显示名必须进个人信息组')
assert.match(defs, /userColor: \{[\s\S]*?group: "个人信息"/, '名字颜色必须进个人信息组')
assert.match(defs, /accent: \{[\s\S]*?group: "强调色"/, '强调色必须进强调色组')
assert.match(defs, /showTabBar: \{[\s\S]*?B\('global'[\s\S]*?group: "布局骨架"/, 'Tab 条必须并入 global/布局骨架')
assert.match(defs, /showPet: \{[\s\S]*?group: "布局骨架", hint: '隐藏 Tab\/侧栏\/宠物/, '布局骨架 hint 必须保留')
assert.match(defs, /global: \[\{ groups: \[\{ title: '个人信息' \}, \{ title: '强调色' \}, \{ title: '布局骨架' \}/, 'GROUP_ORDER.global 必须含新声明式组')
assert.doesNotMatch(settings, /<Group title="个人信息">/, 'Settings 不得再手写个人信息组')
assert.doesNotMatch(settings, /<Group title="强调色">/, 'Settings 不得再手写强调色组')
assert.doesNotMatch(settings, /<Group title="布局骨架">/, 'Settings 不得再手写布局骨架组')
assert.equal((settings.match(/<ConfigBackupRow \/>/g) ?? []).length, 1, 'ConfigBackupRow 不得重复渲染')

console.log('Settings 骨架优化（default 派生/校验器/字段恢复/手写组声明式化）回归测试通过')
