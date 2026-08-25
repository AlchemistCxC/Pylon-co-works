import { strict as assert } from 'node:assert'
import '../src/plugin-runtime/pluginCompositionRoot.ts'
import {
  buildSendMessagePayload,
  clearSessionSourceState,
  emptySessionLiveStats,
  updateSessionLiveStats,
} from '../src/components/chat/sessionRuntime.ts'
import type { Session } from '../src/store.ts'

const session: Session = {
  id: 'local-a',
  agentId: 'agent-a',
  periId: 'peri-a',
  name: 'A',
  source: 'source-a',
  profileId: 'profile-a',
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

assert.equal(payload.agentId, 'agent-a')
assert.equal(payload.source, 'source-a')
assert.equal(payload.content, '测试消息')
assert.equal(payload.persona, '测试人格')
assert.equal(
  payload.sessionPrompt.startsWith('测试人格\n\n只用于当前会话\n\n可用 CLI 命令：'),
  true,
  'Profile persona + 用户提示词 + commandSet 按当前首轮提示词契约组合',
)
assert.deepEqual(payload.attachments, ['G:/tmp/a.txt'])
assert.equal('skills' in payload, false, '未接入的 Skills 不得进入运行时 payload')
assert.equal('hooks' in payload, false, '未接入的 Hooks 不得进入运行时 payload')

const commands = [{ name: 'compact', description: '压缩上下文' }]
const ctxA = { agentId: 'agent-a', source: 'source-a' }
const ctxB = { agentId: 'agent-b', source: 'source-b' }
const keyA = JSON.stringify(['agent-a', 'source-a'])
const keyB = JSON.stringify(['agent-b', 'source-b'])
const runtimeA = updateSessionLiveStats({}, ctxA, {
  tokensUsed: 1200,
  tokensMax: 8000,
  cacheReadTokens: 300,
  commands,
})
const runtimeAB = updateSessionLiveStats(runtimeA, ctxB, { tokensUsed: 25 })
assert.deepEqual(runtimeAB[keyA], {
  tokensUsed: 1200,
  tokensMax: 8000,
  cacheReadTokens: 300,
  commands,
}, '后台 context 更新不得覆盖其他会话快照')
assert.deepEqual(runtimeAB[keyB], {
  ...emptySessionLiveStats(),
  tokensUsed: 25,
}, '新 context 应从明确空态开始')
assert.deepEqual(emptySessionLiveStats(), {
  tokensUsed: 0,
  tokensMax: 131072,
  cacheReadTokens: 0,
  commands: [],
}, '无活动会话必须使用明确空态')

const cleared = clearSessionSourceState({
  context: ctxA,
  sessionLiveStats: runtimeAB,
  sessionModes: { [keyA]: 'edit', [keyB]: 'auto' },
  sessionConfig: { [keyA]: { model: 'a' }, [keyB]: { model: 'b' } },
  generatingSources: ['source-a', 'source-b'],
})
assert.equal(cleared.sessionLiveStats[keyA], undefined)
assert.equal(cleared.sessionModes[keyA], undefined)
assert.equal(cleared.sessionConfig[keyA], undefined)
assert.deepEqual(cleared.generatingSources, ['source-b'])
assert.deepEqual(cleared.sessionLiveStats[keyB], runtimeAB[keyB], '删除 A 不得影响 B 的运行时状态')

console.log('sessionRuntime 回归测试通过')
