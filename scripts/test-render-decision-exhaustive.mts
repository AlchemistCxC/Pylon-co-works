import { strict as assert } from 'node:assert'
import { decideMessageVisibility, prepareRenderableMessages } from '../src/components/chat/messagePipeline.ts'
import { renderDecisionKind, toRenderMessage, type Message } from '../src/components/chat/messageTypes.ts'

const assistant: Message = { id: 'a', role: 'assistant', sender: 'peri', content: 'ok', time: '10:00' }
const emptyAssistant: Message = { ...assistant, id: 'empty', content: '' }
const emptyDecision = decideMessageVisibility(toRenderMessage(emptyAssistant))
assert.equal(emptyDecision.kind, 'skip')
assert.equal(emptyDecision.reason, 'empty-assistant')
assert.equal(renderDecisionKind(emptyDecision), 'skip')
assert.equal(renderDecisionKind(decideMessageVisibility(toRenderMessage(assistant))), 'render')
assert.equal(renderDecisionKind(decideMessageVisibility(toRenderMessage({ ...emptyAssistant, sender: 'system' }))), 'render')
assert.equal(prepareRenderableMessages([emptyAssistant, assistant]).length, 1)
assert.throws(() => renderDecisionKind({ kind: 'future' } as never), /未处理的渲染决策: \[object Object\]/)

console.log('RenderDecision visibility 穷举回归测试通过')
