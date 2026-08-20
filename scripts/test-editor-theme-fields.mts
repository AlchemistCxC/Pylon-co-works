/**
 * STRUCTURE GUARD（结构守卫）：本文件含源码 token/正则断言，不单独构成行为证据；
 * 新业务完成度须配行为级测试（审计报告阶段 0："新业务完成度不得只靠源码 token"）。
 */
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { THEME_FIELD_DEFS, THEME_DEFAULTS, THEME_CSS_VAR_MAP, THEME_SETTING_KEYS, ZONE_FIELDS } from '../src/themeFieldDefs.ts'

// W2-01（F3-D/T4）：FileSheet 编辑器 8 字段——defs 单一真值、chat zone、默认值、cssVar 自动注入

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

// 1. 8 字段全部进 defs：类型/zone/group 正确
for (const field of EDITOR_FIELDS) {
  const def = THEME_FIELD_DEFS[field]
  assert.ok(def, `${field} 必须进 defs`)
  assert.equal(def.zone, 'chat', `${field} 必须属 chat zone（F3-D：不新增 zone）`)
  assert.equal(def.group, '文件编辑器', `${field} 必须归文件编辑器分组`)
  assert.ok(['color', 'number'].includes(def.type), `${field} 类型必须 color/number`)
}

// 2. 默认值派生完整（defs 先行：THEME_DEFAULTS 自动包含，test-defaults-completeness 兜底）
for (const field of EDITOR_FIELDS) {
  assert.ok((THEME_DEFAULTS as Record<string, unknown>)[field] !== undefined, `${field} 必须有默认值`)
}

// 3. cssVar 自动注入（kebab 派生，不手写平行表）
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
  assert.equal(THEME_CSS_VAR_MAP[cssVar], field, `${cssVar} 必须由 defs 自动注入到 ${field}`)
}

// 4. chat zone 字段集包含 8 编辑器字段（Settings 自动渲染）
for (const field of EDITOR_FIELDS) {
  assert.ok(ZONE_FIELDS.chat.includes(field), `${field} 必须进 chat zone 字段集`)
}

// 5. Skin 基线订阅全量 THEME_SETTING_KEYS（8 字段随白名单进入，不逐字段直读 App）
const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
const skinServices = readFileSync(new URL('../src/infrastructure/skin/skinRuntimeServices.ts', import.meta.url), 'utf8')
assert.match(app, /useSkinSurface<HTMLDivElement>\(/)
assert.match(skinServices, /for \(const key of THEME_SETTING_KEYS\)/)
for (const field of EDITOR_FIELDS) {
  assert.ok(THEME_SETTING_KEYS.includes(field), `${field} 必须在 THEME_SETTING_KEYS 白名单`)
}

// 6. 字段数自律：8 封顶（F3-D）
const editorDefs = Object.entries(THEME_FIELD_DEFS).filter(([, def]) => def.group === '文件编辑器')
assert.equal(editorDefs.length, 8, '编辑器字段必须 8 个封顶')

console.log('editor theme fields（F3-D 8 字段）守卫通过')
