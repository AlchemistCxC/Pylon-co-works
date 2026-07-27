import { strict as assert } from 'node:assert'
import {
  addGeneratingSource,
  removeGeneratingSource,
  updateSourceState,
} from '../src/components/chat/sessionEventState.ts'

const messages: Record<string, string[]> = {
  'local:a': ['A-1'],
  'local:b': ['B-1'],
}

updateSourceState(messages, 'local:a', current => [...current, 'A-2'])
assert.deepEqual(messages['local:a'], ['A-1', 'A-2'], '后台 A 应继续接收事件')
assert.deepEqual(messages['local:b'], ['B-1'], 'A 的事件不得污染当前 B')

let generating = addGeneratingSource([], 'local:a')
generating = addGeneratingSource(generating, 'local:b')
generating = addGeneratingSource(generating, 'local:a')
assert.deepEqual(generating, ['local:a', 'local:b'], '生成状态应按 source 去重隔离')

generating = removeGeneratingSource(generating, 'local:a')
assert.deepEqual(generating, ['local:b'], 'A done/error 只应结束 A 的生成态')

console.log('sessionEventState 回归测试通过')
