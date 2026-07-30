import { strict as assert } from 'node:assert'
import { GLOBAL_PRESETS, ZONE_FIELDS } from '../src/presets.ts'

assert.deepEqual(GLOBAL_PRESETS.map(preset => preset.label), ['Claude 风格', 'Glass Light', 'Nord Frost', 'Tokyo Night', 'Solarized Light', 'Amber CRT'])

const [claude, glass, nord, tokyo, solarized, amber] = GLOBAL_PRESETS.map(preset => preset.theme)
assert.equal(claude.uiScheme, 'dark')
assert.equal(claude.globalFont, 'mono')
assert.equal(claude.inputMode, 'cli')
assert.equal(claude.ccVariant, 'terminal')
assert.equal(claude.modelVariant, 'minimal')
assert.equal(claude.modeVariant, 'minimal')
assert.deepEqual(claude.ccHidden, ['send', 'attach'])
assert.equal(claude.globalBgColor, '#000000')
assert.equal(claude.chatBg, '#000000')
assert.equal(claude.chatTextColor, '#FFFFFF')
assert.equal(claude.userTagBg, 'transparent')
assert.equal(claude.userColor, '#D77757')
assert.equal(claude.toolIndicatorGlow, 0)
assert.equal(claude.toolConnectorMode, 'none')
assert.equal(claude.spinnerColor, '#D77757')
assert.equal(claude.ccStyle, 'numeric')
assert.equal(claude.ccHeight, 76)
assert.equal(claude.ccBgHeight, 76)
assert.equal(claude.cliLineColor, '#888888')

assert.equal(glass.uiScheme, 'light')
assert.equal(glass.globalFont, 'system')
assert.equal(glass.ccVariant, 'pill')
assert.equal(glass.ccStyle, 'bar')
assert.equal(glass.modelVariant, 'badge')

assert.equal(nord.uiScheme, 'dark')
assert.equal(nord.globalFont, 'mono')
assert.equal(nord.toolIndicator, '◆')
assert.equal(nord.ccStyle, 'bar')
assert.equal(nord.ccVariant, 'terminal')

assert.equal(tokyo.globalBgColor, '#1a1b26')
assert.equal(tokyo.toolRun, '#7aa2f7')
assert.equal(solarized.uiScheme, 'light')
assert.equal(solarized.globalBgColor, '#fdf6e3')
assert.equal(amber.globalBgColor, '#120b00')
assert.equal(amber.spinnerColor, '#ffb000')

for (const field of [
  'ccPositions', 'ccHidden', 'ccScale', 'ccCliCustomized', 'ccLayoutVersion',
  'ccStyle', 'ccVariant', 'ccHeight', 'ccBgHeight', 'ccBg', 'ccBgImage',
  'cliLinePadding', 'cliPromptColor', 'cliContentOffsetY', 'cliHintMode', 'barTrackColor', 'barFillColor', 'barFillFollow', 'barHeight',
]) {
  assert.equal(ZONE_FIELDS.cc.includes(field as never), true, `CC zone 缺少字段 ${field}`)
}

for (const preset of GLOBAL_PRESETS) {
  assert.equal(Array.isArray(preset.theme.ccHidden), true)
  assert.equal(typeof preset.theme.ccScale, 'object')
  assert.equal(preset.theme.ccCliCustomized, false)
  assert.equal(preset.theme.ccStatusFontSize, 14)
  assert.equal(preset.theme.inputFontSize, 15)
  assert.equal(preset.theme.cliLineWidth, 1)
  assert.equal(preset.theme.cliLinePadding, 3)
  assert.equal(preset.theme.cliContentOffsetY, 0)
  assert.equal(preset.theme.cliHintMode, 'full')
  assert.equal(typeof preset.theme.cliPromptColor, 'string')
}

for (const preset of [glass, nord, tokyo, solarized, amber]) {
  assert.equal(preset.ccHeight, 96)
  assert.equal(preset.ccBgHeight, 96)
}

console.log('presetDesign 回归测试通过')
