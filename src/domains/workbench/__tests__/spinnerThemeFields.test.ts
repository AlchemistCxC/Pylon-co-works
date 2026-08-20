/**
 * 行为化承接 scripts/test-spinner-preview-wiring.mts 的主题字段部分：
 * themeFieldDefs 必须声明 spinner 的 4 个主题字段（间隔 + 三终态标记模式）。
 * 原守卫断言源码 token 存在，这里直接读取字段定义数据断言类型与默认值。
 * （previewSummary 三态接线与 resolveSpinnerMarker 分支已由
 * spinnerPreviewTerminal.test.tsx 行为测试覆盖。）
 */
import { describe, expect, it } from 'vitest'
import { THEME_FIELD_DEFS } from '../../../themeFieldDefs'

describe('spinner 主题字段（spinner-preview-wiring 契约）', () => {
  it('spinnerIntervalMs 定义为 number 字段且默认 120ms', () => {
    const def = THEME_FIELD_DEFS.spinnerIntervalMs
    expect(def).toBeTruthy()
    expect(def.type).toBe('number')
    expect(def.default).toBe(120)
  })

  it('三个终态标记模式均为 select 字段且默认 custom', () => {
    for (const key of ['spinnerDoneMarkerMode', 'spinnerCancelledMarkerMode', 'spinnerErrorMarkerMode'] as const) {
      const def = THEME_FIELD_DEFS[key]
      expect(def).toBeTruthy()
      expect(def.type).toBe('select')
      expect(def.default).toBe('custom')
    }
  })
})
