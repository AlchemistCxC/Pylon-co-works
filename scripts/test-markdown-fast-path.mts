import { strict as assert } from 'node:assert'
import { isPlainTextContent } from '../src/components/chat/markdownFastPath.ts'

const plainSamples = [
  '普通文本，不包含 Markdown 结构。',
  '第一行\n第二行',
  '路径 src/components/chat/ChatView.tsx 保持原样。',
]
for (const sample of plainSamples) assert.equal(isPlainTextContent(sample), true, sample)

const markdownSamples = [
  '**加粗**',
  '`inline code`',
  '[链接](https://example.com)',
  '# 标题',
  '> 引用',
  '- 列表项',
  '1. 有序列表',
  '```ts\nconst value = 1\n```',
  '| 名称 | 值 |\n| --- | --- |\n| a | b |',
  '<span>HTML</span>',
]
for (const sample of markdownSamples) assert.equal(isPlainTextContent(sample), false, sample)

assert.equal(isPlainTextContent('a_b'), true)
assert.equal(isPlainTextContent('a-b'), true)
assert.equal(isPlainTextContent(''), true)

console.log('markdown fast path 回归测试通过')
