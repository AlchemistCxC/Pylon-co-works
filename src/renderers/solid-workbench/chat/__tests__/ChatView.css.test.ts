import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(
  'src/plugins/product/packages/builtin.pylon-renderers/styles/components/chat/ChatView.css',
  'utf8',
)

describe('reasoning row geometry contract', () => {
  it('keeps the collapsed and expanded reasoning header on the same vertical rail', () => {
    const collapsedBlock = css.match(
      /\.app\[data-interface-mode="terminal-like"\] \.term-row-reasoning:has\(\.term-collapse\[data-open="false"\]\) \.term-reasoning\s*\{([\s\S]*?)\n\}/,
    )?.[1] ?? ''

    expect(collapsedBlock).toContain('padding-block: var(--ui-space-1)')
    expect(collapsedBlock).not.toContain('padding-block:0')
  })

  it('keeps reasoning and conversation prose on the message font while inline code opts into mono coloring', () => {
    expect(css).toMatch(/\.term-row-user, \.term-row-assistant\s*\{[^}]*font-family:var\(--msg-font,var\(--chat-font,var\(--mono\)\)\);/s)
    expect(css).toMatch(/\.term-row-reasoning\s*\{[^}]*font-family:var\(--msg-font,var\(--chat-font,var\(--mono\)\)\);/s)
    expect(css).toMatch(/\.term-inline-code\s*\{[^}]*font-family:var\(--mono\);[^}]*color:var\(--chat-code-color,#b47814\);/s)
  })

  it('keeps the assistant marker and body in one non-wrapping flex row', () => {
    const markerBlock = css.match(/\.term-assistant\.has-dot\s*\{([\s\S]*?)\n\}/)?.[1] ?? ''
    expect(markerBlock).toContain('flex-wrap:nowrap')
    expect(markerBlock).toContain('width:100%')
    expect(css).toMatch(/\.term-assistant\.has-dot > \.term-assistant-body\s*\{[^}]*flex:1 1 auto;[^}]*min-width:0;/s)
  })
})
