import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { resolveTerminationScope } from '../src/components/chat/replayState.ts'

const source = readFileSync(new URL('../src/components/chat/sessionRuntimeStore.ts', import.meta.url), 'utf8')

assert.equal(resolveTerminationScope(false), 'live')
assert.equal(resolveTerminationScope(true), 'replay')
assert.equal(resolveTerminationScope(false, true), 'replay')
assert.match(source, /const replay = current\.replaying !== undefined/, 'done/error 必须识别 replay source')
assert.match(source, /const terminationScope = replay \|\| event\.explicitReplay === true \? 'replay' : 'live'/, 'done/error 必须显式合并 replay marker')
assert.match(source, /if \(terminationScope === 'live'\)/, 'replay done/error 不得停止 live generating')
assert.match(source, /settleMessages\(current, replay, now\)/, 'done/error 必须先收敛消息终态')

console.log('replay done/error 与 live 状态分流回归测试通过')
