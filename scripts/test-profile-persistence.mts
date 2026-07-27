import { strict as assert } from 'node:assert'
import { normalizeProfileState, PROFILE_SCHEMA_VERSION } from '../src/profilePersistence.ts'

const defaults = [{ id: 'riccati' }, { id: 'serina' }]

assert.equal(PROFILE_SCHEMA_VERSION, 1)
assert.deepEqual(normalizeProfileState(defaults, 'serina', defaults), {
  profiles: defaults,
  activeProfileId: 'serina',
})
assert.deepEqual(normalizeProfileState(defaults, 'missing', defaults), {
  profiles: defaults,
  activeProfileId: 'riccati',
}, '悬空 activeProfileId 应回退到首个有效 Profile')
assert.deepEqual(normalizeProfileState([], 'missing', defaults), {
  profiles: defaults,
  activeProfileId: 'riccati',
}, '空或损坏的 Profile 集合应恢复默认值')

console.log('profilePersistence 回归测试通过')
