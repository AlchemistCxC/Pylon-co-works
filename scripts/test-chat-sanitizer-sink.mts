/**
 * STRUCTURE GUARD（结构守卫）：本文件含源码 token/正则断言，不单独构成行为证据；
 * 新业务完成度须配行为级测试（审计报告阶段 0："新业务完成度不得只靠源码 token"）。
 */
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../src/components/chat/ChatView.tsx', import.meta.url), 'utf8')

assert.match(source, /import \{ sanitizeHtml \} from ['"]\.\/htmlSanitizer['"]/, 'ChatView 必须导入 sanitizeHtml')
assert.match(
  source,
  /sanitizedLines = useMemo\(\(\) => highlighted[\s\S]*?sanitizeHtml\(html \|\| '&nbsp;'\)/,
  'Starry Night HTML sink 必须先经过 sanitizeHtml（在 useMemo 中逐行清洗）',
)
assert.match(
  source,
  /dangerouslySetInnerHTML=\{\{\s*__html:\s*html \}\}/,
  'Starry Night sink 必须只注入已清洗的 sanitizedLines',
)
assert.equal(
  (source.match(/dangerouslySetInnerHTML/g) || []).length,
  2,
  'ChatView 应保留 Starry Night 与 Anser 两个 HTML sink，Anser sink 留给 B-03',
)

console.log('ChatView Starry Night sanitizer sink 回归测试通过')
