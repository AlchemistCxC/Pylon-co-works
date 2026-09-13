// 迁移自 scripts/test-editor-theme-fields.mts（P91 A1）。
// W2-01（F3-D）：FileSheet 编辑器 8 字段——defs 单一真值、chat zone、默认值、cssVar 自动注入。
// 原脚本读 App.tsx / skinRuntimeServices.ts 的源码正则段（useSkinSurface / THEME_SETTING_KEYS
// 订阅扫描）与 css-var 审计重复，按施工书处置不迁移；其余 defs 数据断言逐条平移。
import { describe, expect, it } from 'vitest'
import { THEME_FIELD_DEFS, THEME_DEFAULTS, THEME_CSS_VAR_MAP, THEME_SETTING_KEYS, ZONE_FIELDS } from '../themeFieldDefs.ts'

const EDITOR_FIELDS = [
  'editorFontSize',
  'editorLineHeight',
  'editorGutterColor',
  'editorGutterBg',
  'editorSelection',
  'editorActiveLine',
  'editorTabActive',
  'editorModifiedMark',
] as const

describe('editor theme fields（F3-D 8 字段，原 test-editor-theme-fields.mts）', () => {
  it('8 字段全部进 defs：类型/zone/group 正确', () => {
    for (const field of EDITOR_FIELDS) {
      const def = THEME_FIELD_DEFS[field]
      expect(def, `${field} 必须进 defs`).toBeTruthy()
      expect(def.zone, `${field} 必须属 chat zone（F3-D：不新增 zone）`).toBe('chat')
      expect(def.group, `${field} 必须归文件编辑器分组`).toBe('文件编辑器')
      expect(['color', 'number'].includes(def.type), `${field} 类型必须 color/number`).toBe(true)
    }
  })

  it('默认值派生完整（defs 先行：THEME_DEFAULTS 自动包含，themeDefaults 兜底）', () => {
    for (const field of EDITOR_FIELDS) {
      expect((THEME_DEFAULTS as Record<string, unknown>)[field] !== undefined, `${field} 必须有默认值`).toBe(true)
    }
  })

  it('cssVar 自动注入（kebab 派生，不手写平行表）', () => {
    const cssVars: Record<string, string> = {
      editorFontSize: '--editor-font-size',
      editorLineHeight: '--editor-line-height',
      editorGutterColor: '--editor-gutter-color',
      editorGutterBg: '--editor-gutter-bg',
      editorSelection: '--editor-selection',
      editorActiveLine: '--editor-active-line',
      editorTabActive: '--editor-tab-active',
      editorModifiedMark: '--editor-modified-mark',
    }
    for (const [field, cssVar] of Object.entries(cssVars)) {
      expect(THEME_CSS_VAR_MAP[cssVar], `${cssVar} 必须由 defs 自动注入到 ${field}`).toBe(field)
    }
  })

  it('chat zone 字段集包含 8 编辑器字段（Settings 自动渲染）', () => {
    for (const field of EDITOR_FIELDS) {
      expect(ZONE_FIELDS.chat.includes(field), `${field} 必须进 chat zone 字段集`).toBe(true)
    }
  })

  it('Skin 基线订阅白名单含 8 编辑器字段（THEME_SETTING_KEYS 数据面）', () => {
    for (const field of EDITOR_FIELDS) {
      expect(THEME_SETTING_KEYS.includes(field), `${field} 必须在 THEME_SETTING_KEYS 白名单`).toBe(true)
    }
  })

  it('字段数自律：8 封顶（F3-D）', () => {
    const editorDefs = Object.entries(THEME_FIELD_DEFS).filter(([, def]) => (def as { group?: string }).group === '文件编辑器')
    expect(editorDefs.length, '编辑器字段必须 8 个封顶').toBe(8)
  })
})
