import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { buildSendMessagePayload } from '../src/components/chat/sessionRuntime.ts'
import { runSendTransaction } from '../src/components/chat/sendTransaction.ts'

const session = {
  id: 'local-session',
  source: 'source-session',
  sessionPrompt: '保持简洁',
} as Parameters<typeof buildSendMessagePayload>[0]['session']

assert.deepEqual(buildSendMessagePayload({
  session,
  content: '/compact',
  persona: 'coder',
  attachments: ['C:/tmp/a.txt'],
}), {
  source: 'source-session',
  content: '/compact',
  persona: 'coder',
  sessionPrompt: '保持简洁',
  attachments: ['C:/tmp/a.txt'],
}, 'compact 必须复用普通发送 payload 的 source、prompt 和附件字段')

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
assert.match(inputBar, /case '\/compact': \{[\s\S]*?attachments: attached\.map\(file => file\.path\)/, 'compact 必须保留附件 payload 语义')
assert.match(inputBar, /case '\/compact': \{[\s\S]*?s\.source !== sessionSource/, 'compact 必须校验 Session 实体和解析 source 一致')

console.log('compact 发送事务回归测试通过')
