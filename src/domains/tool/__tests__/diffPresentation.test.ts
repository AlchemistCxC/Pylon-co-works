// 迁移自 scripts/test-diff-presentation.mts（P91 A1）。diff 纯解析（JSON 对象 / unified / snake 兼容）。
import { describe, expect, it } from 'vitest'
import { normalizeDiffPayload, diffPayloadFromObject } from '../diffPresentation.ts'

describe('diff presentation（原 test-diff-presentation.mts）', () => {
  it('JSON 对象 diff 解析为 removed/added 行', () => {
    const structured = normalizeDiffPayload(JSON.stringify({ oldText: 'const a = 1', newText: 'const a = 2' }))
    expect(structured).toBeTruthy()
    expect(structured!.lines[0].kind).toBe('removed')
    expect(structured!.lines[1].kind).toBe('added')
  })

  it('unified diff 解析为 removed/added 行', () => {
    const unified = normalizeDiffPayload('--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n-old\n+new')
    expect(unified).toBeTruthy()
    expect(unified!.lines[0].kind).toBe('removed')
    expect(unified!.lines[1].kind).toBe('added')
  })

  it('普通工具输出与相同内容不判定 diff', () => {
    expect(normalizeDiffPayload('普通工具输出')).toBe(null)
    expect(normalizeDiffPayload(JSON.stringify({ oldText: 'same', newText: 'same' }))).toBe(null)
  })

  it('P1-10：snake_case diff 转 DiffPayload（tool_diff_content 字段兼容）', () => {
    const snake = diffPayloadFromObject({ old_content: 'x = 1', new_content: 'x = 2' })
    expect(snake).toBeTruthy()
    expect(snake!.lines[0].kind).toBe('removed')
    expect(snake!.lines[1].kind).toBe('added')
    const camel = diffPayloadFromObject({ oldContent: 'a', newContent: 'b' })
    expect(camel).toBeTruthy()
    expect(diffPayloadFromObject({ old_content: 'same', new_content: 'same' }), '相同内容不判定 diff').toBe(null)
    expect(diffPayloadFromObject(null)).toBe(null)
  })
})
