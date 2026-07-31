import { strict as assert } from 'node:assert'
import { assertNever, renderMessageType, toRenderMessage, type Message } from '../src/components/chat/messageTypes.ts'

const base: Message = { id: 'm', role: 'assistant', sender: 'peri', content: 'ok', time: '10:00' }
assert.equal(renderMessageType(toRenderMessage({ ...base, role: 'user' })), 'user')
assert.equal(renderMessageType(toRenderMessage({ ...base, role: 'assistant' })), 'assistant')
assert.equal(renderMessageType(toRenderMessage({ ...base, role: 'reasoning' })), 'reasoning')
assert.equal(renderMessageType(toRenderMessage({ ...base, role: 'tool' })), 'tool_call')
assert.equal(renderMessageType(toRenderMessage({
  ...base,
  role: 'tool',
  toolOutput: 'done',
})), 'tool_result')
assert.throws(() => assertNever('unexpected' as never, '测试'), /测试: unexpected/)

console.log('RenderMessage TypeScript 穷举回归测试通过')
