import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(
  'src/plugins/product/packages/builtin.pylon-workspace/styles/sheets/file/FileSheet.css',
  'utf8',
)

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
})
