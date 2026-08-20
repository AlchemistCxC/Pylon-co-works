/**
 * STRUCTURE GUARD（结构守卫）：本文件含源码 token/正则断言，不单独构成行为证据；
 * 新业务完成度须配行为级测试（审计报告阶段 0："新业务完成度不得只靠源码 token"）。
 */
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { test } from 'vitest'

test('replay done/error 与 live 状态分流结构契约（legacy 迁移）', async () => {

const source = readFileSync(new URL('../src/components/chat/sessionRuntimeStore.ts', import.meta.url), 'utf8')

assert.doesNotMatch(source, /replaying/, 'U2-C 单一路径不得保留 replaying 缓冲')
assert.match(source, /const replay = event\.replay === true \|\| event\.explicitReplay === true/, 'done/error 必须以事件标志识别 replay scope')
assert.match(source, /const terminationScope = replay \? 'replay' : 'live'/, 'done/error 必须显式归一 termination scope')
assert.match(source, /if \(terminationScope === 'live'\)/, 'replay done/error 不得停止 live generating')
assert.match(source, /settleMessages\(current, now\)/, 'done/error 必须先收敛 messages 终态')

console.log('replay done/error 与 live 状态分流回归测试通过')

})
