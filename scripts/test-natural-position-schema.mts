import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'

const presets = readFileSync(new URL('../src/presets.ts', import.meta.url), 'utf8')
const store = readFileSync(new URL('../src/store.ts', import.meta.url), 'utf8')
const profile = readFileSync(new URL('../src/profilePersistence.ts', import.meta.url), 'utf8')

for (const id of ['ekg', 'pct', 'tokens', 'model', 'mode', 'send', 'attach']) {
  const presetEntries = [...presets.matchAll(new RegExp(`${id}:\\s*\\{([^}]*)\\}`, 'g'))]
  assert.equal(presetEntries.length, 3, `${id} 应在三套预设中各出现一次`)
  for (const entry of presetEntries) {
    assert.equal(/\\b[wh]:/.test(entry[1]), false, `${id} 预设不得保存无效 w/h`)
  }
}

assert.equal(store.includes('ccLayoutVersion: CC_LAYOUT_SCHEMA_VERSION'), true)
assert.equal(store.includes('normalizeCcPositions(state.ccPositions, DEFAULTS.ccPositions)'), true)
assert.equal(profile.includes('PROFILE_SCHEMA_VERSION = 2'), true)

console.log('naturalPositionSchema 回归测试通过')