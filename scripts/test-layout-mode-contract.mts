/**
 * STRUCTURE GUARD（结构守卫）：本文件含源码 token/正则断言，不单独构成行为证据；
 * 新业务完成度须配行为级测试（审计报告阶段 0："新业务完成度不得只靠源码 token"）。
 */
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { ZONE_FIELDS } from '../src/themeFieldDefs.ts'

const root = new URL('../', import.meta.url)
const app = readFileSync(new URL('src/App.tsx', root), 'utf8')
const store = readFileSync(new URL('src/store.ts', root), 'utf8')
const migration = readFileSync(new URL('src/domains/theme/migration.ts', root), 'utf8')
const presets = readFileSync(new URL('src/themeFieldDefs.ts', root), 'utf8')
const customPresets = readFileSync(new URL('src/themeFieldDefs.ts', root), 'utf8')
const presetThemes = readFileSync(new URL('src/presets.ts', root), 'utf8')
const settings = readFileSync(new URL('src/components/Settings.tsx', root), 'utf8')
const controlCenter = readFileSync(new URL('src/components/ControlCenter.tsx', root), 'utf8')
const controlCenterCss = readFileSync(new URL('src/plugins/product/packages/builtin.pylon-renderers/styles/components/ControlCenter.css', root), 'utf8')
const ccHeightState = readFileSync(new URL('src/ccHeightState.ts', root), 'utf8')
const inputBar = readFileSync(new URL('src/components/chat/InputBar.tsx', root), 'utf8')
const inputBarCss = readFileSync(new URL('src/plugins/product/packages/builtin.pylon-renderers/styles/components/chat/InputBar.css', root), 'utf8')

assert.match(store, /messageLayout:\s*'classic' \| 'claude' \| 'bubble'/)
assert.match(store, /footerLayout:\s*'free' \| 'peri'/)
assert.match(store, /cliOverflowMode:\s*'fixed-scroll' \| 'grow' \| 'overlay'/)
assert.match(presets, /messageLayout: \{[\s\S]*?default: 'classic'/)
assert.match(presets, /footerLayout: \{[\s\S]*?default: 'free'/)
assert.match(presets, /cliOverflowMode: \{[\s\S]*?default: 'fixed-scroll'/)
// migrate 走 defs 驱动的通用归一化（normalizeThemeState），布局字段回退由 defs default 承担
assert.match(migration, /normalizeThemeState\(state\)/, 'migrate 必须调用 defs 驱动的通用归一化')

{
  const chatFields = ZONE_FIELDS.chat.map(f => String(f))
  const chatOrder = ['msgStyle', 'msgFont', 'msgTextColor', 'msgLineHeight', 'messageLayout']
  const chatIndexes = chatOrder.map(f => chatFields.indexOf(f))
  assert.ok(chatIndexes.every(i => i >= 0) && chatIndexes.every((v, i) => i === 0 || v > chatIndexes[i - 1]), 'chat zone 消息字段顺序契约')
  const ccFields = ZONE_FIELDS.cc.map(f => String(f))
  const ccOrder = ['cliHintMode', 'footerLayout', 'cliOverflowMode']
  const ccIndexes = ccOrder.map(f => ccFields.indexOf(f))
  assert.ok(ccIndexes.every(i => i >= 0) && ccIndexes.every((v, i) => i === 0 || v > ccIndexes[i - 1]), 'cc zone 布局字段顺序契约')
}
// W2-15（F3-B）：delta 格式（每行一字段、双引号）；cliOverflowMode 与默认相等被过滤（展开后为默认）
assert.match(presetThemes, /messageLayout: "claude"/)
assert.match(presetThemes, /footerLayout: "peri"/)
// W2-15（F3-B）：messageLayout 与默认 'classic' 相等的预设不进 delta（展开后为默认）；非默认者必须声明
assert.ok((presetThemes.match(/messageLayout/g) || []).length >= 1, '非默认 messageLayout 预设必须声明')

assert.ok(ZONE_FIELDS.chat.includes('ccScale' as never) || ZONE_FIELDS.cc.includes('ccScale' as never), 'ccScale 必须在某 zone')
assert.ok(ZONE_FIELDS.cc.includes('footerLayout' as never), 'footerLayout 必须在 cc zone')
assert.ok(ZONE_FIELDS.cc.includes('cliOverflowMode' as never), 'cliOverflowMode 必须在 cc zone')
assert.equal(customPresets.includes('ccCliCustomized'), false, 'customPresets 不得再携带 ccCliCustomized')

// S5：布局 data attributes 由 resolved skin 统一投影（不再由 App 直读 Store）
const skinResolver = readFileSync(new URL('src/plugin-runtime/skin/skinResolver.ts', root), 'utf8')
assert.equal(app.includes('{...resolved.dataAttributes}'), true)
assert.equal(skinResolver.includes("'data-message-layout'"), true)
assert.equal(skinResolver.includes("'data-footer-layout'"), true)
assert.equal(skinResolver.includes("'data-cli-overflow-mode'"), true)
assert.match(presets, /\bmessageLayout\b[\s\S]*?'classic', 'claude', 'bubble'/)
assert.match(presets, /\bfooterLayout\b[\s\S]*?'free', 'peri'/)
assert.match(presets, /\bcliOverflowMode\b[\s\S]*?'fixed-scroll', 'grow', 'overlay'/)
assert.match(controlCenter, /footerLayout === 'peri'/)
assert.match(controlCenter, /className="cc-footer cc-footer-peri"/)
assert.match(controlCenter, /className="cc-footer-status-row"/)
assert.match(controlCenterCss, /\.cc-footer-peri \{ display:flex; flex-direction:column;/)
assert.match(controlCenterCss, /\.cc-footer-status-row \{[\s\S]*?display:flex; align-items:center;/)
assert.match(ccHeightState, /export function resolveCcMinHeight/)
assert.match(ccHeightState, /export function resolveVisibleStatusWidgetCount/)
assert.match(ccHeightState, /if \(cliOverflowMode === 'grow'\) return BASE_MIN_HEIGHT/)
assert.match(store, /clampCcHeight\(height, \{/)
assert.match(migration, /state\.ccHeight = clampCcHeight/)
assert.match(controlCenterCss, /min-height:var\(--cc-min-height,64px\)/)
assert.match(presets, /\bccHeight\b[\s\S]*?minFn: t => resolveCcMinHeight/)
assert.match(inputBar, /resolveCliTextareaLayout\(textarea\.scrollHeight, cliOverflowMode\)/)
assert.match(inputBar, /cli-overflow-\$\{cliOverflowMode\}/)
assert.match(inputBarCss, /\.input-bar\.cli-mode\.cli-overflow-fixed-scroll/)
assert.match(inputBarCss, /\.input-bar\.cli-mode\.cli-overflow-overlay \.input-textarea\[data-expanded="true"\]/)
assert.match(controlCenterCss, /data-cli-overflow-mode="grow"/)

console.log('layoutModeContract 回归测试通过')
