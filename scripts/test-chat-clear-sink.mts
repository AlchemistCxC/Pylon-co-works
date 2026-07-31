import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../src/components/chat/chatEventController.ts', import.meta.url), 'utf8')

assert.match(source, /const handleClear = \(\) => \{[\s\S]*?messageOwnerRef\.current[\s\S]*?item\.id === ownerId && item\.source === source[\s\S]*?clearMessageStorage\(session\.id, localStorage\)/, 'peri:clear 必须校验当前 session owner/source 并删除对应消息缓存')
assert.match(source, /messagesBySourceRef\.current\[source\] = \[\]/, 'peri:clear 必须清空 source 内存缓存')
assert.match(source, /setMessages\(\[\]\)/, 'peri:clear 必须清空当前显示消息')
assert.doesNotMatch(source, /const handleClear = \(\) => \{\s*if \(!sessionRef\.current\) return\s*messagesBySourceRef/, '不得只清内存而不清除 localStorage')

console.log('ChatView clear 持久化接入回归测试通过')
