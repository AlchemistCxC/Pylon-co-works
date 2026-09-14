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

// 下沉自 scripts/test-style-guards.mts（P91 A2 拆分）：输入栏队列与变体样式守卫。
describe('input queue and variant style guards', () => {
  it('待发送队列必须声明列表样式', () => {
    expect(css).toMatch(/\.queued-message-list/)
  })

  it('compact/command 输入变体必须有样式', () => {
    expect(css).toMatch(/\.input-bar\.input-variant-compact/)
    expect(css).toMatch(/\.input-bar\.input-variant-command/)
  })
})
