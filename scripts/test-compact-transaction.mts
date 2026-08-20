/**
 * STRUCTURE GUARD（结构守卫）：本文件含源码 token/正则断言，不单独构成行为证据；
 * 新业务完成度须配行为级测试（审计报告阶段 0："新业务完成度不得只靠源码 token"）。
 */
import { strict as assert } from 'node:assert'
import '../src/plugin-runtime/pluginCompositionRoot.ts'
import { readFileSync } from 'node:fs'
import { buildSendMessagePayload } from '../src/components/chat/sessionRuntime.ts'
import { runSendTransaction } from '../src/components/chat/sendTransaction.ts'

const session = {
  id: 'local-session',
  agentId: 'test-agent',
  source: 'source-session',
  sessionPrompt: '保持简洁',
} as Parameters<typeof buildSendMessagePayload>[0]['session']

const payload = buildSendMessagePayload({
  session,
  content: '/compact',
  persona: 'coder',
  attachments: ['C:/tmp/a.txt'],
})
assert.equal(payload.agentId, 'test-agent')
assert.equal(payload.source, 'source-session')
assert.equal(payload.content, '/compact')
assert.equal(payload.persona, 'coder')
assert.equal(payload.sessionPrompt.startsWith('保持简洁\n\n可用 CLI 命令：'), true, 'compact 必须复用普通发送 payload 并注入 commandSet')
assert.deepEqual(payload.attachments, ['C:/tmp/a.txt'], 'compact 必须复用普通发送 payload 的附件字段')

const calls: unknown[] = []
let success = 0
let errors = 0
assert.equal(await runSendTransaction({
  send: async () => { calls.push('send') },
  onSuccess: () => { success++ },
  onError: () => { errors++ },
}), true)
assert.deepEqual(calls, ['send'])
assert.equal(success, 1)
assert.equal(errors, 0)

success = 0
errors = 0
assert.equal(await runSendTransaction({
  send: async () => { throw new Error('compact failed') },
  onSuccess: () => { success++ },
  onError: error => {
    errors++
    assert.equal((error as Error).message, 'compact failed')
  },
}), false)
assert.equal(success, 0, 'compact 失败不得执行清空输入/附件')
assert.equal(errors, 1)

const inputBar = readFileSync(new URL('../src/components/chat/InputBar.tsx', import.meta.url), 'utf8')
assert.match(inputBar, /case '\/compact': \{[\s\S]*?buildSendMessagePayload\(/, 'compact 必须使用统一发送 payload helper')
assert.match(inputBar, /case '\/compact': \{[\s\S]*?runSendTransaction\(/, 'compact 必须使用统一发送事务')
assert.match(inputBar, /case '\/compact': \{[\s\S]*?onError: error => setSendError\(String\(error\)\)/, 'compact 必须复用统一错误显示路径')
assert.match(inputBar, /case '\/compact': \{[\s\S]*?attachments: attached\.filter\(file => file\.status !== 'error'\)\.map\(file => file\.path\)/, 'compact 必须保留附件 payload 语义（过滤 error）')
assert.match(inputBar, /case '\/compact': \{[\s\S]*?s\.source !== sessionSource/, 'compact 必须校验 Session 实体和解析 source 一致')

console.log('compact 发送事务回归测试通过')
