import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import {
  resolveTerminationScope,
  settleReplayToolMessages,
} from '../src/components/chat/replayState.ts'

const source = readFileSync(new URL('../src/components/chat/sessionRuntimeStore.ts', import.meta.url), 'utf8')

assert.equal(resolveTerminationScope(true), 'replay')
assert.equal(resolveTerminationScope(false), 'live')
assert.deepEqual(
  settleReplayToolMessages([
    { role: 'tool', running: true },
    { role: 'tool', running: false, toolStatus: 'failed' },
    { role: 'assistant', running: true },
  ]),
  [
    { role: 'tool', running: false, toolStatus: 'completed' },
    { role: 'tool', running: false, toolStatus: 'failed' },
    { role: 'assistant', running: true },
  ],
)
assert.match(source, /const terminationScope = replay \|\| event\.explicitReplay === true \? 'replay' : 'live'/, 'done/error 必须显式区分 replay/live scope')
assert.match(source, /message\.role === 'tool' && message\.running/, 'done/error 必须先收敛 replay tool 终态')
assert.doesNotMatch(source, /shouldApplyLiveTermination/, '旧二值终止 helper 不应继续使用')

console.log('历史 Tool replay 终态收敛回归测试通过')
