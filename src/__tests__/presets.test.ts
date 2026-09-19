// 迁移自 scripts/test-cc-status-font-size.mts（P91 A1）
// 只迁 presets.ts 相关纯函数断言（zone 归属 + pickZoneFields）；
// 原脚本 store/defs/App/CSS/skin/settingsDomains 的源码文本段由 css-var 审计覆盖，不迁。
import { describe, expect, it } from 'vitest'
import { GLOBAL_PRESETS, fallbackPresetChip } from '../presets/index.ts'
import { pickZoneFields } from '../zones/index.ts'
import { ZONE_FIELDS } from '../themeFieldDefs.ts'

const field = 'ccStatusFontSize'

describe('ccStatusFontSize zone 归属契约', () => {
  it('built-in 与 custom preset 路径都把字段保留在 cc zone，且不重复归属', () => {
    expect(ZONE_FIELDS.cc.includes(field)).toBe(true)
    expect(ZONE_FIELDS.cc.filter(item => item === field).length).toBe(1)
  })

  it('cc zone 字段顺序契约：ccBgImage < ccStatusFontSize < ccVariant', () => {
    const ccIndexes = ZONE_FIELDS.cc.map(item => String(item))
    const bg = ccIndexes.indexOf('ccBgImage')
    const size = ccIndexes.indexOf('ccStatusFontSize')
    const style = ccIndexes.indexOf('ccVariant')
    expect(bg >= 0 && size > bg && style > size).toBe(true)
  })

  it('pickZoneFields 从 cc zone 提取 ccStatusFontSize，不提取 chat 字段', () => {
    const explicitPresetTheme = pickZoneFields({ ccStatusFontSize: 17, chatFontSize: 99 }, 'cc')
    expect(explicitPresetTheme.ccStatusFontSize).toBe(17)
    expect('chatFontSize' in explicitPresetTheme).toBe(false)
    expect(pickZoneFields({ ccStatusFontSize: 17 }, 'chat').ccStatusFontSize).toBeUndefined()
  })

  it('built-in preset 应用提取子集后保留而非抹除 ccStatusFontSize', () => {
    // built-in preset 未覆写时可继承 DEFAULTS 的值；
    // 因此应用提取子集必须保留默认值而不是擦除它。
    for (const preset of GLOBAL_PRESETS) {
      const subset = pickZoneFields(preset.theme, 'cc')
      const applied = { ccStatusFontSize: 14, ...subset }
      expect(typeof applied.ccStatusFontSize).toBe('number')
    }
  })
})

describe('fallbackPresetChip（#116 子项 7）', () => {
  it('内置预设 name 不产生兜底 chip', () => {
    expect(fallbackPresetChip(GLOBAL_PRESETS[0].name, [])).toBeNull()
  })

  it('自定义预设 id 不产生兜底 chip（具名列表负责渲染，避免重复点亮）', () => {
    expect(fallbackPresetChip('custom-1788421103162', ['custom-1788421103162'])).toBeNull()
  })

  it("'custom' 哨兵显示为「自定义」而不是原样输出", () => {
    expect(fallbackPresetChip('custom', ['custom-1'])).toEqual({
      label: '自定义',
      title: '当前外观已偏离预设基准',
    })
  })

  it('未识别的值显示为「未知预设」，原值只留在 title 里', () => {
    const chip = fallbackPresetChip('ghost-preset-7', ['custom-1'])
    expect(chip?.label).toBe('未知预设')
    expect(chip?.label).not.toContain('ghost-preset-7')
    expect(chip?.title).toContain('ghost-preset-7')
  })

  it('空状态无 chip', () => {
    expect(fallbackPresetChip('', ['custom-1'])).toBeNull()
  })
})
