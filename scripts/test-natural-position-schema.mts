import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'

const presets = readFileSync(new URL('../src/presets.ts', import.meta.url), 'utf8')
const store = readFileSync(new URL('../src/store.ts', import.meta.url), 'utf8')
const migration = readFileSync(new URL('../src/themeMigration.ts', import.meta.url), 'utf8')
const profile = readFileSync(new URL('../src/profilePersistence.ts', import.meta.url), 'utf8')

for (const id of ['ekg', 'pct', 'tokens', 'model', 'mode', 'send', 'attach']) {
  const matches = [...presets.matchAll(new RegExp(`${id}:\\s*\\{`, 'g'))]
  assert.equal(matches.length, 0, `${id} 坐标对象必须已从预设中删除（v3 以 slot layout 为真值）`)
}

assert.equal(store.includes('ccLayoutVersion: CC_LAYOUT_SCHEMA_VERSION'), false)
assert.equal(migration.includes('normalizeCcPositions('), false)
assert.equal(profile.includes('PROFILE_SCHEMA_VERSION = 3'), true)

console.log('naturalPositionSchema 回归测试通过')
