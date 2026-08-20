import { strict as assert } from 'node:assert'
import { GLOBAL_PRESETS, ZONE_FIELDS } from '../src/presets.ts'
import { THEME_DEFAULTS } from '../src/themeFieldDefs.ts'

// W2-15（F3-B）：预设是 delta——断言经 { ...THEME_DEFAULTS, ...delta } 展开后的有效值
const expand = (theme: Record<string, unknown>) => ({ ...THEME_DEFAULTS, ...theme })

assert.deepEqual(GLOBAL_PRESETS.map(preset => preset.label), ['Claude 风格', 'Glass Light', 'Nord Frost', 'Tokyo Night', 'Solarized Light', 'Amber CRT'])

const [claude, glass, nord, tokyo, solarized, amber] = GLOBAL_PRESETS.map(preset => expand(preset.theme as Record<string, unknown>))
assert.equal(claude.uiScheme, 'dark')
assert.equal(claude.globalFont, 'system')
assert.equal(claude.inputMode, 'cli')
assert.equal(claude.ccVariant, 'terminal')
assert.equal(claude.modelVariant, 'minimal')
assert.equal(claude.modeVariant, 'minimal')
assert.deepEqual(claude.ccHidden, ['send', 'attach'])
assert.equal(claude.globalBgColor, '#000000')
assert.equal(claude.chatBg, '#000000')
assert.equal(claude.chatTextColor, '#FFFFFF')
// CC 用户消息整行灰底（userMessageBackground 暗色）
assert.equal(claude.userTagBg, '#373737')
assert.equal(claude.messageLayout, 'claude')
assert.equal(claude.footerLayout, 'peri')
assert.equal(claude.cliOverflowMode, 'fixed-scroll')
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
assert.equal(nord.globalFont, 'system')
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
  'ccHidden', 'ccScale',
  'ccStyle', 'ccVariant', 'ccHeight', 'ccBgHeight', 'ccBg', 'ccBgImage',
  'cliLinePadding', 'cliPromptColor', 'cliContentOffsetY', 'cliHintMode', 'barTrackColor', 'barFillColor', 'barFillFollow', 'barHeight',
]) {
  assert.equal(ZONE_FIELDS.cc.includes(field as never), true, `CC zone 缺少字段 ${field}`)
}

for (const preset of GLOBAL_PRESETS) {
  const expanded = expand(preset.theme as Record<string, unknown>)
  assert.equal(expanded.globalFont, 'system', '聊天区外的内置预设必须使用界面字体')
  assert.equal(Array.isArray(expanded.ccHidden), true)
  assert.equal(typeof expanded.ccScale, 'object')
  assert.equal('ccCliCustomized' in preset.theme, false, '预设不得携带废弃 ccCliCustomized')
  assert.equal('ccPositions' in preset.theme, false, '预设不得携带废弃 ccPositions')
  assert.equal(expanded.ccStatusFontSize, 16)
  assert.equal(expanded.inputFontSize, 17)
  assert.equal(expanded.cliLineWidth, 2)
  assert.equal(expanded.cliLinePadding, 3)
  assert.equal(expanded.cliContentOffsetY, 0)
  assert.equal(expanded.cliHintMode, 'full')
  assert.equal(typeof expanded.cliPromptColor, 'string')
}

for (const preset of [glass, nord, tokyo, solarized, amber]) {
  assert.equal(preset.ccHeight, 96)
  assert.equal(preset.ccBgHeight, 96)
}

console.log('presetDesign 回归测试通过')
