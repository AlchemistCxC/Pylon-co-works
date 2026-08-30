import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const chatCss = readFileSync(new URL('../../../plugins/product/packages/builtin.pylon-renderers/styles/components/chat/ChatView.css', import.meta.url), 'utf8')

describe('terminal-like 块间距 contract', () => {
  it('uses one explicit cadence token set at the terminal-like boundary', () => {
    expect(chatCss).toMatch(/\.app\[data-interface-mode="terminal-like"\] \.term\s*\{[^}]*--chat-row-gap:\s*8px/)
    expect(chatCss).toMatch(/\.app\[data-interface-mode="terminal-like"\] \.term\s*\{[^}]*--chat-tool-gap:\s*4px/)
    expect(chatCss).toMatch(/\.app\[data-interface-mode="terminal-like"\] \.term\s*\{[^}]*--chat-activity-gap:\s*6px/)
  })

  it('assigns Solid inter-row spacing to the wrapper, not the message body', () => {
    expect(chatCss).toMatch(/\.app\[data-interface-mode="terminal-like"\] \.plain-message-list__row \+ \.plain-message-list__row\s*\{[^}]*padding-block-start:\s*var\(--chat-row-gap\)/)
    expect(chatCss).toMatch(/\.term-plain-text\s*\{[^}]*line-height:inherit/)
  })

  it('keeps the legacy ChatView row/tool cadence available for non-Solid consumers', () => {
    expect(chatCss).toMatch(/\.term-row \+ \.term-row\s*\{[^}]*margin-top:\s*var\(--chat-row-gap/)
    expect(chatCss).toMatch(/\.term-row-tool \+ \.term-row-tool\s*\{[^}]*margin-top:\s*var\(--chat-tool-gap/)
  })
})
