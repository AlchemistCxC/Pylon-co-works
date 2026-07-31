import { strict as assert } from 'node:assert'
import { normalizeDiffPayload } from '../src/components/chat/diffPresentation.ts'

const structured = normalizeDiffPayload(JSON.stringify({ oldText: 'const a = 1', newText: 'const a = 2' }))
assert.ok(structured)
assert.equal(structured.lines[0].kind, 'removed')
assert.equal(structured.lines[1].kind, 'added')

const unified = normalizeDiffPayload('--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n-old\n+new')
assert.ok(unified)
assert.equal(unified.lines[0].kind, 'removed')
assert.equal(unified.lines[1].kind, 'added')

assert.equal(normalizeDiffPayload('普通工具输出'), null)
assert.equal(normalizeDiffPayload(JSON.stringify({ oldText: 'same', newText: 'same' })), null)

console.log('diff presentation 回归测试通过')