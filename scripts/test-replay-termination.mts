import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { resolveTerminationScope } from '../src/components/chat/replayState.ts'

const source = readFileSync(new URL('../src/components/chat/chatEventController.ts', import.meta.url), 'utf8')

assert.equal(resolveTerminationScope(false), 'live')
assert.equal(resolveTerminationScope(true), 'replay')
assert.equal(resolveTerminationScope(false, true), 'replay')
assert.match(source, /const replay = refs\.replayingSourcesRef\.current\[source\] !== undefined/, 'done/error 必须识别 replay source')
assert.match(source, /const terminationScope = resolveTerminationScope\(replay, event\.payload\.replay === true\)/, 'done/error 必须显式合并 replay marker')
assert.match(source, /if \(terminationScope === 'live'\) \{\s*stopGenerating\(source\)/, 'replay done/error 不得停止 live generating')
assert.match(source, /updateSourceMessages\(source, prev => settleReplayToolMessages\(/, 'done/error 必须先收敛 replay tool 终态')

console.log('replay done/error 与 live 状态分流回归测试通过')
