import { strict as assert } from 'node:assert'
import { buildSendMessagePayload } from '../src/components/chat/sessionRuntime.ts'
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

console.log('sessionRuntime 回归测试通过')