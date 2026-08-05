import { strict as assert } from 'node:assert'
import { normalizeDiffPayload, diffPayloadFromObject } from '../src/domains/tool/diffPresentation.ts'

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

// P1-10：snake_case diff 转 DiffPayload（tool_diff_content 字段兼容）
const snake = diffPayloadFromObject({ old_content: 'x = 1', new_content: 'x = 2' })
assert.ok(snake)
assert.equal(snake.lines[0].kind, 'removed')
assert.equal(snake.lines[1].kind, 'added')
const camel = diffPayloadFromObject({ oldContent: 'a', newContent: 'b' })
assert.ok(camel)
assert.equal(diffPayloadFromObject({ old_content: 'same', new_content: 'same' }), null, '相同内容不判定 diff')
assert.equal(diffPayloadFromObject(null), null)

console.log('diff presentation 回归测试通过')
