import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(
  'src/plugins/product/packages/builtin.pylon-workspace/styles/sheets/file/FileSheet.css',
  'utf8',
)

/** 取某选择器**最后**一条规则体——CSS 同优先级下后者生效，契约块在文件末尾。 */
function lastRuleBody(selector: string): string {
  const needle = `${selector} {`
  const at = css.lastIndexOf(needle)
  expect(at, `缺少规则：${selector}`).toBeGreaterThan(-1)
  const start = css.indexOf('{', at) + 1
  return css.slice(start, css.indexOf('}', start))
}

describe('FileSheet code geometry contract', () => {
  it('uses one token set for read-only and CodeMirror projections', () => {
    expect(css).toContain('--file-code-font-size: var(--editor-font-size, 13px)')
    expect(css).toContain('--file-code-line-height: var(--editor-line-height, 1.5)')
    expect(css).toContain('--file-code-gutter-width: 56px')
    expect(css).toContain('.file-tab-gutter {')
    expect(css).toContain('.file-code-editor .cm-gutters {')
    expect(css).toContain('flex: 0 0 var(--file-code-gutter-width)')
    expect(css).toContain('padding: 0 var(--file-code-line-inset)')
  })

  // issue #69：切换编辑/只读态时行号列与内容左边界必须零位移。
  it('keeps the line-number column geometry identical in both projections', () => {
    const readOnlyGutter = lastRuleBody('.file-tab-gutter')
    const editorGutters = lastRuleBody('.file-code-editor .cm-gutters')
    // 行号列宽度：两态同源 token（56px）
    for (const body of [readOnlyGutter, editorGutters]) {
      expect(body).toContain('flex: 0 0 var(--file-code-gutter-width)')
      expect(body).toContain('width: var(--file-code-gutter-width)')
      expect(body).toContain('box-sizing: border-box')
    }
    // 行号文字右内边距：两态同为 12px ⇒ 文字右边缘同为 56px − 12px = 44px
    expect(readOnlyGutter).toContain(
      'padding: var(--file-code-top-padding) 12px var(--file-code-bottom-padding) 8px',
    )
    const gutterElementRules = css.match(/\.file-code-editor \.cm-lineNumbers \.cm-gutterElement \{[^}]*\}/g) ?? []
    expect(gutterElementRules.some(body => body.includes('padding: 0 12px 0 8px'))).toBe(true)
  })

  // issue #69 根因：CodeMirror 的 gutter 列按内容定宽，不铺满固定宽度的 gutter 盒，
  // 行号文字因此比只读态左移约一个右内边距（见 CSS 内注释）。
  it('fills the fixed gutter box with the CodeMirror gutter column', () => {
    const gutterColumn = lastRuleBody('.file-code-editor .cm-gutters .cm-gutter')
    expect(gutterColumn).toContain('flex: 1 1 auto')
    expect(gutterColumn).toContain('min-width: 0')
  })

  it('keeps the line box, left inset and vertical padding on the shared tokens', () => {
    for (const selector of ['.file-tab-line', '.file-code-editor .cm-line']) {
      const body = lastRuleBody(selector)
      expect(body).toContain(
        'min-height: calc(var(--file-code-font-size) * var(--file-code-line-height))',
      )
      expect(body).toContain('padding: 0 var(--file-code-line-inset)')
    }
    expect(lastRuleBody('.file-tab-pre')).toContain(
      'padding: var(--file-code-top-padding) 24px var(--file-code-bottom-padding) 0',
    )
    expect(lastRuleBody('.file-code-editor .cm-content')).toContain(
      'padding: var(--file-code-top-padding) 0 var(--file-code-bottom-padding)',
    )
  })
})
