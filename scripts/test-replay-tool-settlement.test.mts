/**
 * STRUCTURE GUARD（结构守卫）：本文件含源码 token/正则断言，不单独构成行为证据；
 * 新业务完成度须配行为级测试（审计报告阶段 0："新业务完成度不得只靠源码 token"）。
 */
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { test } from 'vitest'

test('历史 Tool replay 终态收敛结构契约（legacy 迁移）', async () => {

const source = readFileSync(new URL('../src/components/chat/sessionRuntimeStore.ts', import.meta.url), 'utf8')

assert.doesNotMatch(source, /replaying/, 'U2-C 单一路径不得保留 replaying 缓冲')
assert.match(source, /const terminationScope = replay \? 'replay' : 'live'/, 'done/error 必须显式区分 replay/live scope')
assert.match(source, /message\.role === 'tool' && message\.running/, 'done/error 必须先收敛 replay tool 终态')
assert.doesNotMatch(source, /shouldApplyLiveTermination/, '旧二值终止 helper 不应继续使用')

console.log('历史 Tool replay 终态收敛回归测试通过')

})
