import { strict as assert } from 'node:assert'
import { resolveLoadedMessages, serializeLoadedMessages, shouldStartLiveGeneration } from '../src/components/chat/replayState.ts'

const cached = [{ id: 'cached', content: '旧缓存' }]
const replayed = [{ id: 'replayed', content: 'Peri 历史' }]

assert.equal(shouldStartLiveGeneration({ replay: true }), false, 'replay 用户消息不应启动实时生成态')
assert.equal(shouldStartLiveGeneration({ replay: false }), true, '实时用户消息应启动生成态')
assert.deepEqual(resolveLoadedMessages({ loadSucceeded: true, cached, replayed }), replayed)
assert.deepEqual(resolveLoadedMessages({ loadSucceeded: false, cached, replayed: [] }), cached)
assert.equal(serializeLoadedMessages(replayed), JSON.stringify(replayed), '成功 replay 应覆盖本地缓存')
assert.equal(serializeLoadedMessages([]), null, '空 replay 应删除旧缓存，避免下次恢复陈旧历史')

console.log('replayState 回归测试通过')
