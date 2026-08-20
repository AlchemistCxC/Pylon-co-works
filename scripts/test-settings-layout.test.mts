/**
 * STRUCTURE GUARD（结构守卫）：本文件含源码 token/正则断言，不单独构成行为证据；
 * 新业务完成度须配行为级测试（审计报告阶段 0："新业务完成度不得只靠源码 token"）。
 */
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { test } from 'vitest'

test('Settings 骨架优化回归（legacy 迁移）', async () => {

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const defs = read('../src/themeFieldDefs.ts')
const renderer = read('../src/themeFieldRenderer.tsx')
const settings = read('../src/components/Settings.tsx')
const store = read('../src/store.ts')
const presetReducer = read('../src/domains/theme/presetReducer.ts')
const migration = read('../src/domains/theme/migration.ts')
const presets = read('../src/presets.ts')

// ── 低频组默认折叠 + 组粒度合并 ──
assert.match(defs, /defaultOpen: false/, '低频组必须声明默认折叠')
assert.match(defs, /\{ title: '语法高亮', compact: true, defaultOpen: false \}/, '语法高亮组默认折叠')
assert.match(defs, /\{ title: '代码差异', defaultOpen: false \}/, '代码差异组默认折叠')
assert.match(defs, /\{ title: '助手标记', defaultOpen: false \}/, '助手标记组默认折叠')
assert.match(defs, /\{ title: '状态信息', defaultOpen: false \}/, '状态信息组默认折叠')
// 背景+玻璃效果合并：chatTransparency/chatBlur 归入"背景"
assert.match(defs, /chatTransparency: \{[\s\S]*?group: "背景"/, '透明度并入背景组')
assert.match(defs, /chatBlur: \{[\s\S]*?group: "背景"/, '模糊并入背景组')
// 指示器+连接线合并：工具三色归入“指示器与连接线”
assert.match(defs, /toolOk: \{[\s\S]*?group: "指示器与连接线"/, '工具完成状态并入指示器与连接线')
assert.match(defs, /toolRun: \{[\s\S]*?group: "指示器与连接线"/, '工具运行状态并入指示器与连接线')
assert.match(defs, /toolErr: \{[\s\S]*?group: "指示器与连接线"/, '工具错误状态并入指示器与连接线')
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

// ── Settings：工具栏（搜索 + 重置本区）+ nav custom 圆点（I13-W1：经 sectionZone 派生 zone）──
assert.match(settings, /className="set-search"/, '设置页必须有搜索输入框')
assert.match(settings, /set-zone-reset/, '必须有重置本区按钮')
assert.match(settings, /resetZone\(sectionZone\(activeSection\)/, '重置本区必须接线到 store.resetZone')
assert.match(settings, /\$\{zone && custom\[zone\] \? ' custom' : ''\}/, '导航按钮必须显示 custom 圆点')
assert.match(settings, /const isSearching = searchQuery\.trim\(\)\.length > 0/, '搜索状态必须驱动手写组隐藏')

// ── store：resetZone 只重置标量主题字段 ──
assert.match(store, /resetZone: \(zone\) => set\(state => \{/, 'store 必须实现 resetZone')
assert.match(store, /ZONE_FIELDS\[zone\]/, 'resetZone 必须按 zone 字段表重置')
assert.match(store, /typeof value === 'string' \|\| typeof value === 'number' \|\| typeof value === 'boolean'/, 'resetZone 必须只重置标量（不碰 ccLayout/ccHidden/ccScale）')
assert.match(store, /appliedPreset: \{ \.\.\.state\.appliedPreset, \[zone\]: '' \}/, 'resetZone 必须清 appliedPreset[zone]')
assert.match(store, /custom: \{ \.\.\.state\.custom, \[zone\]: false \}/, 'resetZone 必须清 custom[zone]')

// ── 停滞颜色标签中性化 ──
assert.match(defs, /spinnerStalledColor: \{[\s\S]*?'长时间等待颜色'/, '长时间等待字段应说明真实状态')
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
assert.match(migration, /normalizeThemeState\(state\)/, 'migrate 必须调用 defs 驱动的归一化')
assert.match(presetReducer, /normalizeThemeState\(pickCustomPresetTheme/, 'applyCustomPreset 必须防御性归一化')

// ── 骨架：字段级恢复默认 ──
assert.match(renderer, /set-field-reset/, '字段级恢复默认按钮必须存在')
assert.match(renderer, /Object\.is\(value, def\.default\)/, '恢复默认判定必须比对 defs default')

// ── 死字段清理：动态波形未实现，7 个动画细节字段必须删除；ekgWidth 走 --ekg-w ──
for (const dead of ['ekgFontSize', 'ekgLineWidth', 'ekgAmplitudeMax', 'ekgSpeedBase', 'ekgSpeedMax', 'ekgLeftColor', 'ekgMovingColor']) {
  assert.doesNotMatch(defs, new RegExp(`\\b${dead}\\b`), `死字段 ${dead} 必须从 defs 删除`)
  assert.doesNotMatch(store, new RegExp(`\\b${dead}\\b`), `死字段 ${dead} 必须从 ThemeSettings 删除`)
}
assert.match(defs, /ekgWidth: \{[\s\S]*?cssVar: '--ekg-w'/, 'ekgWidth 必须注入 --ekg-w（StatusBar 消费）')
// CSS 消费审计（2026-08-04）：无渲染消费的死字段必须删除（含预设/类型）
for (const dead of ['toolNameColor', 'toolSummaryColor', 'ekgConsumedColor', 'tokenDisplay']) {
  assert.doesNotMatch(defs, new RegExp(`\\b${dead}\\b`), `死字段 ${dead} 必须从 defs 删除`)
  assert.doesNotMatch(store, new RegExp(`\\b${dead}\\b`), `死字段 ${dead} 必须从 ThemeSettings 删除`)
  assert.doesNotMatch(presets, new RegExp(`\\b${dead}\\b`), `死字段 ${dead} 必须从全部预设删除`)
}
assert.doesNotMatch(store, /ekgLeftColor: string; ekgMovingColor/, 'store 不得残留 ekgLeftColor/ekgMovingColor')

// ── 中低危修复契约（2026-08-03 逻辑检测二轮）──
const controller = read('../src/components/chat/chatEventController.ts')
// 预设应用必须 clamp ccHeight（claude 预设 76 < 最小高）
assert.match(presetReducer, /syncPresetCcHeight\(/, '预设应用必须过 ccHeight clamp')
assert.match(presetReducer, /ccHeight !== undefined \? syncPresetCcHeight\(theme\) : \{\}/, 'setGlobalPreset/applyCustomPreset 必须 clamp ccHeight')
assert.match(presetReducer, /zone === 'cc' && presetTheme\.ccHeight !== undefined/, 'applyZonePreset 必须 clamp cc zone ccHeight')
// removeCustomPreset 删除已应用预设 → 'custom'（与 markZoneCustom 一致）
assert.match(presetReducer, /appliedPreset\[zone\] = ''/, '删除已应用预设必须清除基准')
// getFrames 空帧返回 undefined（spinner fallback 生效）
assert.match(controller, /frames && frames\.length > 0 \? frames : undefined/, 'getFrames 空帧必须返回 undefined')
// 配置导入 key 白名单
const configImport = read('../src/configExportImport.ts')
assert.match(configImport, /allowed\.has\(key\)/, '导入必须按 CONFIG_STORAGE_KEYS 白名单过滤')
// commitReplay 合并 load 期间 live 消息（验收回归 D3 重放重新设计）：
// 不再按位置 slice(cached.length)（切换会话时位置对应破坏→串会话/复读叠加），
// 改为 loadBaseMessageIds 基准（仅本轮 load 之后新增的 live 消息）+
// identity 去重合并 replay 权威与 live 增量。
assert.match(controller, /loadBaseMessageIds/, 'commitReplay 必须用 loadBaseMessageIds 识别 load 期间 live 增量')
assert.match(controller, /mergeReplayMessages\([\s\S]*?replayed[\s\S]*?identityCapabilities[\s\S]*?\)/, 'commitReplay 必须按 identity 合并 replay 权威与 live 增量（无 identity 保守保留）')
assert.match(controller, /seq: maxSeq/, 'initSource 必须从缓存推进 seq（live/replay id 不撞）')

console.log('Settings 骨架优化（default 派生/校验器/字段恢复/手写组声明式化）回归测试通过')

})
