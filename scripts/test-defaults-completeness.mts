import { strict as assert } from 'node:assert'
import { DEFAULTS } from '../src/domains/theme/themeDefaults.ts'
import { THEME_FIELD_KEYS } from '../src/themeFieldDefs.ts'

// Q1（外部审阅结论）：默认值完整性用运行时断言，不做类型体操。
// 每个主题字段（含 meta/对象字段）都必须在 DEFAULTS 有值——加字段漏默认值即红。
const missing: string[] = []
for (const key of THEME_FIELD_KEYS) {
  if ((DEFAULTS as Record<string, unknown>)[key] === undefined) missing.push(key)
}
assert.deepEqual(missing, [], `DEFAULTS 缺少必填键：${missing.join(', ')}`)

console.log(`DEFAULTS 完整性断言通过（${THEME_FIELD_KEYS.length} 个主题字段全有默认值）`)
