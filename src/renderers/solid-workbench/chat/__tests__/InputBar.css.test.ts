import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(
  'src/plugins/product/packages/builtin.pylon-renderers/styles/components/chat/InputBar.css',
  'utf8',
)

describe('input message-rail typography contract', () => {
  it('uses the shared message font and line-height for every input variant', () => {
    expect(css).toMatch(/\.input-textarea\s*\{[^}]*font-family:var\(--msg-font,var\(--chat-font,var\(--mono\)\)\);/s)
    expect(css).toMatch(/\.input-textarea\s*\{[^}]*line-height:var\(--msg-line-height,var\(--chat-line-height,1\.35\)\);/s)
    expect(css).not.toContain('font-family:var(--msg-font,var(--mono)) !important')
  })

  it('keeps composer and queued-message prose on the same fallback rail', () => {
    expect(css).toMatch(/\.queued-message-editor\s*\{[^}]*font-family:var\(--msg-font,var\(--chat-font,var\(--mono\)\)\);/s)
    expect(css).toMatch(/\.input-composer-meta[\s\S]*?font:600 10px var\(--msg-font,var\(--chat-font,var\(--mono\)\)\);/s)
    expect(css).not.toMatch(/\.input-textarea[^}]*font-family:var\(--msg-font,var\(--chat-font,var\(--font\)\)\)/s)
  })
})
