/**
 * STRUCTURE GUARD（结构守卫）：本文件含源码 token/正则断言，不单独构成行为证据；
 * 新业务完成度须配行为级测试（审计报告阶段 0："新业务完成度不得只靠源码 token"）。
 */
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../src/components/chat/chatEventController.ts', import.meta.url), 'utf8')

assert.match(source, /const handleClear = \(\) => \{[\s\S]*?messageOwnerRef\.current[\s\S]*?item\.id === ownerId && item\.source === source[\s\S]*?clearMessageStorage\(session\.id, localStorage\)/, 'peri:clear 必须校验当前 session owner/source 并删除对应消息缓存')
assert.match(source, /dispatch\(\{ type: 'clear', source \}\)/, 'peri:clear 必须通过 reducer 清空 source 消息')
assert.match(source, /refs\.setMessages\(next\.messages\)/, '消息清空由 syncRendered 同步到渲染层')
assert.doesNotMatch(source, /const handleClear = \(\) => \{\s*if \(!sessionRef\.current\) return\s*messagesBySourceRef/, '不得只清内存而不清除 localStorage')

console.log('ChatView clear 持久化接入回归测试通过')
