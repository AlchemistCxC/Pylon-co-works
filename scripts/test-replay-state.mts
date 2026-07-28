import { strict as assert } from 'node:assert'
import {
  isReplayEvent,
  resolveLoadedMessages,
  serializeLoadedMessages,
  shouldStartLiveGeneration,
} from '../src/components/chat/replayState.ts'

const cached = [{ id: 'cached', content: '旧缓存' }]
const replayed = [{ id: 'replayed', content: 'Peri 历史' }]

assert.equal(isReplayEvent({ eventReplay: true, loadInProgress: false }), true, '显式 replay 标记应进入恢复缓冲区')
assert.equal(isReplayEvent({ eventReplay: false, loadInProgress: true }), true, 'load 生命周期内的事件应视为 replay')
assert.equal(isReplayEvent({ eventReplay: false, loadInProgress: false }), false, '普通实时事件不应视为 replay')
assert.equal(shouldStartLiveGeneration({ replay: true }), false, 'replay 用户消息不应启动实时生成态')
assert.equal(shouldStartLiveGeneration({ replay: false }), true, '实时用户消息应启动生成态')
assert.deepEqual(resolveLoadedMessages({ loadSucceeded: true, cached, replayed }), replayed)
assert.deepEqual(
  resolveLoadedMessages({ loadSucceeded: true, cached, replayed: [] }),
  cached,
  'load 成功但 replay 为空时必须保留本地缓存',
)
assert.deepEqual(resolveLoadedMessages({ loadSucceeded: false, cached, replayed: [] }), cached)
assert.equal(serializeLoadedMessages(replayed), JSON.stringify(replayed), '成功 replay 应覆盖本地缓存')
assert.equal(serializeLoadedMessages(cached), JSON.stringify(cached), '空 replay 回退缓存时不得删除旧历史')
assert.equal(serializeLoadedMessages([]), null, '没有缓存且 replay 也为空时无需写入空数组')

console.log('replayState 回归测试通过')
