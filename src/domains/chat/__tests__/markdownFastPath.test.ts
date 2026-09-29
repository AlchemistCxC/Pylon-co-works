// 迁移自 scripts/test-markdown-fast-path.mts（P91 A1）
import { describe, expect, it } from 'vitest'
import { isPlainTextContent } from '../markdownFastPath.ts'

describe('markdown fast path 纯文本判定（迁移自 scripts/test-markdown-fast-path.mts，P91 A1）', () => {
  it('纯文本走 fast path', () => {
    const plainSamples = [
      '普通文本，不包含 Markdown 结构。',
      '第一行\n第二行',
      '路径 src/renderers/solid-workbench/SolidWorkbenchApp.solid.tsx 保持原样。',
    ]
    for (const sample of plainSamples) expect(isPlainTextContent(sample)).toBe(true)
  })

  it('Markdown 结构不走 fast path', () => {
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
    for (const sample of markdownSamples) expect(isPlainTextContent(sample)).toBe(false)
  })

  it('下划线/连字符/空串不误判为 Markdown', () => {
    expect(isPlainTextContent('a_b')).toBe(true)
    expect(isPlainTextContent('a-b')).toBe(true)
    expect(isPlainTextContent('')).toBe(true)
  })
})
