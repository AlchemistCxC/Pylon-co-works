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
  it('keeps terminal-like assistant and tool markers in the same fixed left column', () => {
    expect(chatCss).toContain('.app[data-interface-mode="terminal-like"] :is(')
    expect(chatCss).toContain('.term-assistant.has-dot > .term-assistant-dot')
    expect(chatCss).toContain('.term-tool-head > .term-tool-indicator')
    expect(chatCss).toMatch(/\.app\[data-interface-mode="terminal-like"\] :is\([\s\S]*?\)\s*\{[^}]*font-family\s*:\s*var\(--chat-font,var\(--mono\)\)\s*;[^}]*font-size\s*:\s*var\(--chat-font-size,var\(--font-size-lg\)\)\s*;[^}]*line-height\s*:\s*var\(--chat-line-height,1\.35\)\s*;[^}]*width\s*:\s*var\(--dot-col-width, 1\.6em\)\s*;[^}]*flex\s*:\s*0 0 var\(--dot-col-width, 1\.6em\)\s*;[^}]*justify-content\s*:\s*flex-start\s*;[^}]*text-align\s*:\s*left\s*;/s)
    expect(chatCss).toMatch(/\.app\[data-interface-mode="terminal-like"\] \.term-tool-head > \.term-tool-indicator\s*\{[^}]*justify-content\s*:\s*flex-start\s*;[^}]*text-align\s*:\s*left\s*;[^}]*font-family\s*:\s*var\(--chat-font, var\(--mono\)\)\s*;[^}]*font-size\s*:\s*var\(--chat-font-size, var\(--font-size-lg\)\)\s*;[^}]*line-height\s*:\s*var\(--chat-line-height, 1\.35\)\s*;/s)
    expect(chatCss).not.toMatch(/\.app\[data-interface-mode="terminal-like"\][^{}]*\{[^}]*scale\s*:/s)
  })

  it('removes first-block top spacing through renderer slot wrappers', () => {
    expect(chatCss).toMatch(/\.term-assistant\.has-dot > \.term-assistant-body > :first-child\s*\{[^}]*margin-top\s*:\s*0\s*;/s)
    expect(chatCss).toContain('.term-assistant.has-dot > .term-assistant-body > :first-child > :first-child,')
    expect(chatCss).toMatch(/\.term-assistant\.has-dot > \.term-assistant-body > :first-child > :first-child > :first-child\s*\{[^}]*margin-top\s*:\s*0\s*;/s)
  })

  it('does not vertically offset the tool indicator from the assistant marker', () => {
    expect(chatCss).not.toMatch(/\.term-tool-indicator\s*\{[^}]*margin-top\s*:\s*\.16em\s*;/s)
  })

  it('pins assistant and tool markers to the same chat-rail typography in every interface mode', () => {
    // 指示器字号契约：助手标记与工具指示器同字体同字号（否则槽位渲染器的
    // 局部字号覆盖会静默缩小工具字形 —— 真实应用与开发模式不一致的根因）。
    expect(chatCss).toMatch(
      /\.term-assistant\.has-dot > \.term-assistant-dot,\s*\.term-tool-indicator\s*\{[^}]*font-family\s*:\s*var\(--chat-font,\s*var\(--mono\)\)\s*;[^}]*font-size\s*:\s*var\(--chat-font-size,\s*var\(--font-size-lg\)\)\s*;/s,
    )
    // 槽位渲染器不得再用更高特异性的 inherit 链覆盖契约
    expect(chatCss).not.toContain('.solid-tool-invocation .term-tool-indicator')
  })

  it('keeps ordered-list markers inside the reasoning scroll port', () => {
    expect(chatCss).toMatch(/\.term-reasoning-body\s+:is\(ol,ul\)\s*\{[^}]*padding-inline-start\s*:\s*2em\s*;/s)
  })
})
