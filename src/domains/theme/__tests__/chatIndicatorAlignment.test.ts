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
  it('keeps modern tool and assistant indicators on the same left edge', () => {
    expect(chatCss).toMatch(/\.app\[data-interface-mode="modern-gui"\] \.term-row-tool\s*\{[^}]*margin-left\s*:\s*0\s*;/s)
    expect(chatCss).toMatch(/\.app\[data-interface-mode="modern-gui"\] \.term-tool-head\s*\{[^}]*padding\s*:\s*0 16px\s*;/s)
  })

  it('removes first-block top spacing through renderer slot wrappers', () => {
    expect(chatCss).toMatch(/\.term-assistant\.has-dot > \.term-assistant-body > :first-child\s*\{[^}]*margin-top\s*:\s*0\s*;/s)
    expect(chatCss).toContain('.term-assistant.has-dot > .term-assistant-body > :first-child > :first-child,')
    expect(chatCss).toMatch(/\.term-assistant\.has-dot > \.term-assistant-body > :first-child > :first-child > :first-child\s*\{[^}]*margin-top\s*:\s*0\s*;/s)
  })

  it('does not vertically offset the tool indicator from the assistant marker', () => {
    expect(chatCss).not.toMatch(/\.term-tool-indicator\s*\{[^}]*margin-top\s*:\s*\.16em\s*;/s)
  })
})
