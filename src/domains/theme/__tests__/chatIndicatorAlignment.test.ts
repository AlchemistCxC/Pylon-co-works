import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// 与同目录 radiusContract/streamingWrapContract 同款：URL→pathname 手工转换，
// 规避 readFileSync(URL) 在当前 tsconfig lib 下的类型不兼容（TS2769）。
const chatCss = (() => {
  const pathname = decodeURIComponent(
    new URL('../../../plugins/product/packages/builtin.pylon-renderers/styles/components/chat/ChatView.css', import.meta.url).pathname,
  ).replace(/^\/([A-Za-z]:)/, '$1')
  return readFileSync(pathname, 'utf8')
})()

describe('chat indicator alignment contract', () => {
  it('centres terminal-like assistant and tool markers in the same fixed column', () => {
    expect(chatCss).toContain('.app[data-interface-mode="terminal-like"] :is(')
    expect(chatCss).toContain('.term-assistant.has-dot > .term-assistant-dot,')
    expect(chatCss).toContain('.term-tool-head > .term-tool-indicator')
    expect(chatCss).toMatch(/\.app\[data-interface-mode="terminal-like"\] :is\([\s\S]*?\)\s*\{[^}]*font-family\s*:\s*var\(--chat-font,var\(--mono\)\)\s*;[^}]*font-size\s*:\s*var\(--chat-font-size,var\(--font-size-lg\)\)\s*;[^}]*line-height\s*:\s*var\(--chat-line-height,1\.35\)\s*;[^}]*width\s*:\s*var\(--dot-col-width, 1\.6em\)\s*;[^}]*flex\s*:\s*0 0 var\(--dot-col-width, 1\.6em\)\s*;[^}]*justify-content\s*:\s*center\s*;/s)
    expect(chatCss).toMatch(/\.app\[data-interface-mode="terminal-like"\] :is\([\s\S]*?\)\s*\{[^}]*scale\s*:\s*\.86\s*;/s)
  })

  it('removes first-block top spacing through renderer slot wrappers', () => {
    expect(chatCss).toMatch(/\.term-assistant\.has-dot > \.term-assistant-body > :first-child\s*\{[^}]*margin-top\s*:\s*0\s*;/s)
    expect(chatCss).toContain('.term-assistant.has-dot > .term-assistant-body > :first-child > :first-child,')
    expect(chatCss).toMatch(/\.term-assistant\.has-dot > \.term-assistant-body > :first-child > :first-child > :first-child\s*\{[^}]*margin-top\s*:\s*0\s*;/s)
  })

  it('does not vertically offset the tool indicator from the assistant marker', () => {
    expect(chatCss).not.toMatch(/\.term-tool-indicator\s*\{[^}]*margin-top\s*:\s*\.16em\s*;/s)
  })

  it('keeps ordered-list markers inside the reasoning scroll port', () => {
    expect(chatCss).toMatch(/\.term-reasoning-body\s+:is\(ol,ul\)\s*\{[^}]*padding-inline-start\s*:\s*2em\s*;/s)
  })
})
