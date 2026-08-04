import { strict as assert } from 'node:assert'
import { assertNever, toRenderMessage, type Message } from '../src/components/chat/messageTypes.ts'

const base: Message = { id: 'm', role: 'assistant', sender: 'peri', content: 'ok', time: '10:00' }
assert.equal(toRenderMessage({ ...base, role: 'user' }).type, 'user')
assert.equal(toRenderMessage({ ...base, role: 'assistant' }).type, 'assistant')
assert.equal(toRenderMessage({ ...base, role: 'reasoning' }).type, 'reasoning')
assert.equal(toRenderMessage({ ...base, role: 'tool' }).type, 'tool_call')
assert.equal(toRenderMessage({
  ...base,
  role: 'tool',
  toolOutput: 'done',
}).type, 'tool_result')
assert.equal(toRenderMessage({ ...base, sender: 'system' }).type, 'error')
assert.equal(toRenderMessage({ ...base, role: 'future-role' as Message['role'] }).type, 'system')
assert.throws(() => assertNever('unexpected' as never, '测试'), /测试: unexpected/)

console.log('RenderMessage TypeScript 穷举回归测试通过')
