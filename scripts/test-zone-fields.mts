/**
 * STRUCTURE GUARD（结构守卫）：本文件含源码 token/正则断言，不单独构成行为证据；
 * 新业务完成度须配行为级测试（审计报告阶段 0："新业务完成度不得只靠源码 token"）。
 */
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { ZONE_FIELDS } from '../src/presets.ts'
import { THEME_FIELD_OWNERS } from '../src/themeFieldDefs.ts'

const storeSource = readFileSync(new URL('../src/store.ts', import.meta.url), 'utf8')
const themeInterface = storeSource.match(/export interface ThemeSettings\s*\{([\s\S]*?)\n\}/)?.[1]
assert.ok(themeInterface, 'store.ts 必须包含 ThemeSettings 接口')

const themeFields = [...themeInterface.matchAll(/([A-Za-z_$][\w$]*)\s*\??\s*:/g)]
  .filter(match => {
    const prefix = themeInterface.slice(0, match.index)
    let depth = 0
    for (const character of prefix) {
      if (character === '{') depth += 1
      else if (character === '}') depth -= 1
    }
    return depth === 0
  })
  .map(match => match[1])
assert.ok(themeFields.length > 0, 'ThemeSettings 字段集合不得为空')

const explicitMetaFields = new Set(['appliedPreset', 'custom', 'ccEditMode'])
const expectedOwnerOverrides: Record<string, string> = {
  sidebarWidth: 'workspace-layout',
  showPet: 'workspace-layout',
  rightWidth: 'right-rail',
}
const allowedZones = new Set(['global', 'layout', 'sidebar', 'chat', 'cc', 'right'])
const themeFieldSet = new Set(themeFields)
const mappedEntries = Object.entries(ZONE_FIELDS)
const illegalZones = mappedEntries.map(([zone]) => zone).filter(zone => !allowedZones.has(zone))
const duplicateFields = new Set<string>()
const seenFields = new Set<string>()
const illegalFields = new Set<string>()

for (const [zone, fields] of mappedEntries) {
  assert.ok(Array.isArray(fields), `ZONE_FIELDS.${zone} 必须是字段数组`)
  for (const field of fields) {
    if (!themeFieldSet.has(field)) illegalFields.add(field)
    if (seenFields.has(field)) duplicateFields.add(field)
    seenFields.add(field)
  }
}

const coveredThemeFields = new Set([...seenFields].filter(field => !explicitMetaFields.has(field)))
const missingOwners = [...coveredThemeFields].filter(field => !(field in THEME_FIELD_OWNERS))
const illegalOwners = [...coveredThemeFields].filter(field => !['theme', 'workspace-layout', 'right-rail'].includes(THEME_FIELD_OWNERS[field as keyof typeof THEME_FIELD_OWNERS]?.owner))
for (const [field, owner] of Object.entries(expectedOwnerOverrides)) {
  assert.equal(THEME_FIELD_OWNERS[field as keyof typeof THEME_FIELD_OWNERS]?.owner, owner, `${field} owner 必须保持当前 authority`)
}
const missingFields = themeFields.filter(field => !explicitMetaFields.has(field) && !coveredThemeFields.has(field))
const unexpectedMetaMappings = themeFields.filter(field => explicitMetaFields.has(field) && seenFields.has(field))

const problems = [
  illegalZones.length ? `非法 zone: ${illegalZones.join(', ')}` : '',
  illegalFields.size ? `非法字段: ${[...illegalFields].join(', ')}` : '',
  duplicateFields.size ? `重复归属字段: ${[...duplicateFields].join(', ')}` : '',
  missingFields.length ? `遗漏字段: ${missingFields.join(', ')}` : '',
  unexpectedMetaMappings.length ? `元字段不应映射: ${unexpectedMetaMappings.join(', ')}` : '',
  missingOwners.length ? `缺少 owner: ${missingOwners.join(', ')}` : '',
  illegalOwners.length ? `非法 owner: ${illegalOwners.join(', ')}` : '',
].filter(Boolean)

assert.equal(problems.length, 0, `ZONE_FIELDS 一致性契约失败\n${problems.join('\n')}`)

console.log(`ZONE_FIELDS 一致性契约通过（${coveredThemeFields.size} 个主题字段，排除元字段：${[...explicitMetaFields].join(', ')}）`)
