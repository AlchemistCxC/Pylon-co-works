import { strict as assert } from 'node:assert'
import {
  buildSendMessagePayload,
  clearSessionSourceState,
  emptySessionLiveStats,
  updateSessionLiveStats,
} from '../src/components/chat/sessionRuntime.ts'
import type { Session } from '../src/store.ts'

const session: Session = {
  id: 'local-a',
  periId: 'peri-a',
  name: 'A',
  source: 'source-a',
  profileId: 'riccati',
  createdAt: 1,
  lastActiveAt: 1,
  platform: 'local',
  workdir: 'G:/Project/example',
  sessionPrompt: '只用于当前会话',
  skills: ['legacy-skill'],
  hooks: ['legacy-hook'],
  autoName: '',
}

const payload = buildSendMessagePayload({
  session,
  content: '测试消息',
  persona: '测试人格',
  attachments: ['G:/tmp/a.txt'],
})

assert.deepEqual(payload, {
  source: 'source-a',
  content: '测试消息',
  persona: '测试人格',
  sessionPrompt: '只用于当前会话',
  attachments: ['G:/tmp/a.txt'],
})
assert.equal('skills' in payload, false, '未接入的 Skills 不得进入运行时 payload')
assert.equal('hooks' in payload, false, '未接入的 Hooks 不得进入运行时 payload')

const commands = [{ name: 'compact', description: '压缩上下文' }]
const runtimeA = updateSessionLiveStats({}, 'source-a', {
  tokensUsed: 1200,
  tokensMax: 8000,
  cacheReadTokens: 300,
  commands,
})
const runtimeAB = updateSessionLiveStats(runtimeA, 'source-b', { tokensUsed: 25 })
assert.deepEqual(runtimeAB['source-a'], {
  tokensUsed: 1200,
  tokensMax: 8000,
  cacheReadTokens: 300,
  commands,
}, '后台 source 更新不得覆盖其他会话快照')
assert.deepEqual(runtimeAB['source-b'], {
  ...emptySessionLiveStats(),
  tokensUsed: 25,
}, '新 source 应从明确空态开始')
assert.deepEqual(emptySessionLiveStats(), {
  tokensUsed: 0,
  tokensMax: 131072,
  cacheReadTokens: 0,
  commands: [],
}, '无活动会话必须使用明确空态')

const cleared = clearSessionSourceState({
  source: 'source-a',
  sessionLiveStats: runtimeAB,
  sessionModes: { 'source-a': 'edit', 'source-b': 'auto' },
  sessionConfig: { 'source-a': { model: 'a' }, 'source-b': { model: 'b' } },
  generatingSources: ['source-a', 'source-b'],
})
assert.equal(cleared.sessionLiveStats['source-a'], undefined)
assert.equal(cleared.sessionModes['source-a'], undefined)
assert.equal(cleared.sessionConfig['source-a'], undefined)
assert.deepEqual(cleared.generatingSources, ['source-b'])
assert.deepEqual(cleared.sessionLiveStats['source-b'], runtimeAB['source-b'], '删除 A 不得影响 B 的运行时状态')

console.log('sessionRuntime 回归测试通过')