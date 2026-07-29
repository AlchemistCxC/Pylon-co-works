import { strict as assert } from 'node:assert'
import { isKnownSource, isRenderedSource, removeGeneratingSource } from '../src/components/chat/sessionEventState.ts'
import { readFileSync } from 'node:fs'

assert.equal(isKnownSource('source-a', ['source-a', 'source-b']), true)
assert.equal(isKnownSource('source-deleted', ['source-a', 'source-b']), false)
assert.equal(isKnownSource('', ['source-a']), false)
assert.equal(isRenderedSource('source-a', 'source-a'), true)
assert.equal(isRenderedSource('source-a', 'source-b'), false)
assert.equal(isRenderedSource('source-a', null), false)
assert.deepEqual(removeGeneratingSource(['source-a', 'source-b'], 'source-deleted'), ['source-a', 'source-b'])

const source = readFileSync(new URL('../src/components/chat/ChatView.tsx', import.meta.url), 'utf8')
assert.match(source, /const isActiveSource = \(source: string\) => isKnownSource/, '事件入口必须校验 source 是否仍属于现有 session')
assert.match(source, /if \(!isActiveSource\(source\)\) return/, '已删除 session 的旧 source 事件必须被丢弃')

console.log('删除 session 后旧 source 事件隔离回归测试通过')
