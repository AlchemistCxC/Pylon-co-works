import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { themeToCssVars } from '../src/components/settings/templateThemeVars.ts'
import { THEME_CSS_VAR_MAP, THEME_DEFAULTS } from '../src/themeFieldDefs.ts'
import { GLOBAL_PRESETS } from '../src/presets.ts'

// W2-14：模板库——预览局部 cssVars 不触全局 store；点击才应用；恢复重应用 delta

// 1. themeToCssVars：对 delta 展开 { ...THEME_DEFAULTS, ...delta } 派生局部 cssVars（单一真值）
{
  const expanded = { ...THEME_DEFAULTS, ...GLOBAL_PRESETS[0].theme }
  const vars = themeToCssVars(expanded)
  for (const [cssVar, key] of Object.entries(THEME_CSS_VAR_MAP)) {
    const value = (expanded as Record<string, unknown>)[key]
    if (value !== undefined) assert.equal(vars[cssVar], String(value), `${cssVar} 必须从快照派生`)
  }
  assert.equal(vars['--accent'], String(expanded.accent), 'accent 必须注入')
  assert.equal(themeToCssVars({}).hasOwnProperty('--accent'), false, '缺省字段不注入')
}

// 2. 组件接线：官方 6 + 自定义两区；预览不写 store（局部 style）；点击才应用
const library = readFileSync(new URL('../src/components/settings/TemplateLibrary.tsx', import.meta.url), 'utf8')
assert.match(library, /GLOBAL_PRESETS\.map/, '官方模板必须来自 6 预设')
assert.match(library, /customPresets\.map/, '必须有自定义模板区')
assert.match(library, /themeToCssVars\(template\.theme\)/, '预览必须经局部 cssVars')
assert.equal(library.includes('setZoneField'), false, '预览路径不得写全局 store（局部 cssVars）')
assert.match(library, /onClick=\{\(\) => \{/, '点击才应用')
assert.match(library, /applyCustomPreset\(template\.name\)/, '自定义点击必须应用')
assert.match(library, /onRestore\(template\.name\)/, '恢复模板必须重应用')

// 3. 恢复此模板默认 = 重应用当前 delta（delta 语义：{ ...THEME_DEFAULTS, ...delta } 覆盖手调字段）
const settings = readFileSync(new URL('../src/components/Settings.tsx', import.meta.url), 'utf8')
assert.match(settings, /<TemplateLibrary onApply=\{applyGlobalPreset\} onRestore=\{applyGlobalPreset\} \/>/, '恢复 = 重应用当前预设（清手调字段）')

// 4. 官方区 6 个模板展开后 theme 完整（delta 展开到全量）
{
  const official = GLOBAL_PRESETS.map(preset => ({ ...THEME_DEFAULTS, ...preset.theme }))
  assert.equal(official.length, 6)
  for (const theme of official) {
    assert.equal(theme.accent !== undefined, true, '展开后 accent 必有值')
    assert.equal(theme.ccHeight !== undefined, true)
  }
}

console.log('template library 守卫通过')
