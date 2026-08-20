import { strict as assert } from 'node:assert'
import { belongsToProfile, resolveSessionProfile } from '../src/components/chat/sessionProfile.ts'
import type { Profile, Session } from '../src/store.ts'

const profiles: Profile[] = [
  { id: 'a', name: 'A', persona: 'persona-a', model: 'model-a' },
  { id: 'b', name: 'B', persona: 'persona-b', model: 'model-b' },
]
const sessions: Session[] = [
  { id: 'local-a', name: 'A', source: 'source-a', profileId: 'a', createdAt: 1, lastActiveAt: 1, platform: 'local', workdir: '', sessionPrompt: '', skills: [], hooks: [], autoName: '' },
  { id: 'local-b', name: 'B', source: 'source-b', profileId: 'b', createdAt: 1, lastActiveAt: 1, platform: 'local', workdir: '', sessionPrompt: '', skills: [], hooks: [], autoName: '' },
]

assert.equal(resolveSessionProfile('local-a', sessions, profiles)?.persona, 'persona-a')
assert.equal(resolveSessionProfile('source-b', sessions, profiles)?.persona, 'persona-b')
assert.equal(resolveSessionProfile(null, sessions, profiles), undefined)
assert.equal(belongsToProfile('local-a', 'a', sessions), true)
assert.equal(belongsToProfile('local-a', 'b', sessions), false)
assert.equal(belongsToProfile(null, 'b', sessions), true)

console.log('sessionProfile 回归测试通过')