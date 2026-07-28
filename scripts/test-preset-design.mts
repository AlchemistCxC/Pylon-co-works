import { strict as assert } from 'node:assert'
import { GLOBAL_PRESETS, ZONE_FIELDS } from '../src/presets.ts'

assert.deepEqual(GLOBAL_PRESETS.map(preset => preset.label), ['Claude Code', 'Glass Light', 'Nord Frost'])

const [claude, glass, nord] = GLOBAL_PRESETS.map(preset => preset.theme)
assert.equal(claude.uiScheme, 'dark')
assert.equal(claude.globalFont, 'mono')
assert.equal(claude.inputMode, 'cli')
assert.equal(claude.ccVariant, 'terminal')
assert.equal(claude.modelVariant, 'minimal')
assert.deepEqual(claude.ccHidden, ['send', 'attach'])

assert.equal(glass.uiScheme, 'light')
assert.equal(glass.globalFont, 'system')
assert.equal(glass.ccVariant, 'pill')
assert.equal(glass.ccStyle, 'numeric')
assert.equal(glass.modelVariant, 'badge')

assert.equal(nord.uiScheme, 'dark')
assert.equal(nord.globalFont, 'mono')
assert.equal(nord.toolIndicator, '◆')
assert.equal(nord.ccStyle, 'bar')
assert.equal(nord.ccVariant, 'terminal')

for (const field of [
  'ccPositions', 'ccHidden', 'ccScale', 'ccCliCustomized', 'ccLayoutVersion',
  'ccStyle', 'ccVariant', 'ccHeight', 'ccBgHeight', 'ccBg', 'ccBgImage',
  'cliLinePadding', 'barTrackColor', 'barFillColor', 'barFillFollow', 'barHeight',
]) {
  assert.equal(ZONE_FIELDS.cc.includes(field as never), true, `CC zone 缺少字段 ${field}`)
}

for (const preset of GLOBAL_PRESETS) {
  assert.equal(Array.isArray(preset.theme.ccHidden), true)
  assert.equal(typeof preset.theme.ccScale, 'object')
  assert.equal(preset.theme.ccCliCustomized, false)
}

console.log('presetDesign 回归测试通过')
