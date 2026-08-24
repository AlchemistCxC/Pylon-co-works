/**
 * STRUCTURE GUARD（结构守卫）：本文件含源码 token/正则断言，不单独构成行为证据；
 * 新业务完成度须配行为级测试（审计报告阶段 0："新业务完成度不得只靠源码 token"）。
 */
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { GLOBAL_PRESETS, ZONE_FIELDS, pickZoneFields } from '../src/presets.ts'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const app = read('../src/App.tsx')
const css = read('../src/plugins/product/packages/builtin.pylon-renderers/styles/components/ControlCenter.css')
const store = read('../src/store.ts')
const customPresets = read('../src/themeFieldDefs.ts')

const field = 'ccStatusFontSize'

// ThemeSettings/default contract.
assert.match(store, /ccStatusFontSize:\s*number/)
assert.match(store, /ccBgImage:\s*string\s*\n\s*ccStatusFontSize:\s*number/)
assert.match(customPresets, /ccBgImage: \{[\s\S]*?default: '',/)

// Built-in and custom preset paths must retain the field in the cc zone.
assert.equal(ZONE_FIELDS.cc.includes(field as never), true, 'CC zone 缺少 ccStatusFontSize')
assert.equal(ZONE_FIELDS.cc.filter(item => item === field).length, 1, 'ccStatusFontSize 在 CC zone 重复归属')
{
  const ccIndexes = ZONE_FIELDS.cc.map(item => String(item))
  const bg = ccIndexes.indexOf('ccBgImage')
  const size = ccIndexes.indexOf('ccStatusFontSize')
  const style = ccIndexes.indexOf('ccStyle')
  assert.ok(bg >= 0 && size > bg && style > size, 'cc zone 字段顺序契约：ccBgImage < ccStatusFontSize < ccStyle')
}

const explicitPresetTheme = pickZoneFields({ ccStatusFontSize: 17, chatFontSize: 99 }, 'cc')
assert.equal(explicitPresetTheme.ccStatusFontSize, 17, 'CC 预设未提取 ccStatusFontSize')
assert.equal('chatFontSize' in explicitPresetTheme, false, 'CC 预设错误提取了 chat 字段')
assert.equal(pickZoneFields({ ccStatusFontSize: 17 }, 'chat').ccStatusFontSize, undefined, 'ccStatusFontSize 错误映射到 chat zone')

// Built-in presets may inherit the DEFAULTS value when they do not override it;
// applying the extracted subset must therefore preserve the default rather than erase it.
for (const preset of GLOBAL_PRESETS) {
  const subset = pickZoneFields(preset.theme, 'cc')
  const applied = { ccStatusFontSize: 14, ...subset }
  assert.equal(typeof applied.ccStatusFontSize, 'number', `${preset.name} CC 预设路径丢失 ccStatusFontSize`)
}

// App state -> Skin 基线 -> CSS custom property -> ControlCenter consumer.
// S5：App 不再逐字段直读；ccStatusFontSize 经 THEME_SETTING_KEYS 全量进入 Skin 基线
const skinServices = read('../src/infrastructure/skin/skinRuntimeServices.ts')
assert.equal(app.includes('useSkinSurface<HTMLDivElement>('), true)
assert.match(skinServices, /for \(const key of THEME_SETTING_KEYS\)/)
// cssVar 注入由 defs 声明驱动（unit: 'px' → App 循环注入 --cc-status-font-size）
assert.match(customPresets, /\bccStatusFontSize\b[\s\S]*?unit: 'px'/)
assert.match(css, /\.cc-status-row\s*\{[\s\S]*?font-size:\s*max\(14px,\s*var\(--cc-status-font-size,\s*14px\)\)/)

// Settings entry -> zone-aware update path（声明式：defs 声明 + settingsDomains SECTION_ZONES 映射，
// I13-W1：TAB_ZONE_MAP 随 tier 导航退役，section→zone 归属收敛到 settingsDomains 单一真值）
const settingsDomains = read('../src/settingsDomains.ts')
assert.match(settingsDomains, /cc:\s*'cc'/)
assert.match(customPresets, /\bccStatusFontSize:\s*\{\s*\.\.\.N\('cc', '状态信息字号', 14, 20\)[\s\S]*?unit: 'px'/)

console.log('ccStatusFontSize 闭环契约测试通过')
