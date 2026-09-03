import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(
  'src/plugins/product/packages/builtin.pylon-renderers/styles/components/chat/ChatView.css',
  'utf8',
)
const chromeCss = readFileSync(
  'src/plugins/product/packages/builtin.pylon-renderers/styles/components/solid-workbench/WorkbenchChrome.css',
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

  it('does not apply a negative horizontal transform to the streaming indicator row', () => {
    expect(css).not.toContain('transform: translateX(-4px)')
  })

  it('keeps tool prose on the message font while code/path surfaces opt into mono', () => {
    expect(css).toMatch(/\.term-tool-body\s*\{[^}]*font-family:var\(--msg-font,var\(--chat-font,var\(--mono\)\)\);/s)
    expect(css).toMatch(/\.term-tool-summary-code\s*\{\s*font-family:var\(--mono\);/s)
    expect(css).toMatch(/\.term-tool-body :is\([^)]*\.term-code-block[^)]*\)\s*\{\s*font-family:var\(--mono\);/s)
  })

  it('keeps tool headers and indicators on the message font when no token is supplied', () => {
    expect(css).toMatch(/\.app\[data-interface-mode="terminal-like"\] :is\([\s\S]*?\.term-tool-head\s*\)\s*\{[^}]*font-family:var\(--msg-font,var\(--chat-font,var\(--mono\)\)\);/s)
    expect(css).toMatch(/\.term-tool-head,\s*\.term-tool-name,[\s\S]*?\.term-spinner-row \.spinner-activity\s*\{[^}]*font-family:var\(--msg-font,var\(--chat-font,var\(--mono\)\)\);/s)
    expect(css).toMatch(/\.term-assistant\.has-dot > \.term-assistant-dot,[\s\S]*?\.term-tool-head > \.term-tool-indicator\s*\{[^}]*font-family:var\(--msg-font,var\(--chat-font,var\(--mono\)\)\);/s)

    const terminalAssistantMarker = css.match(
      /\.app\[data-interface-mode="terminal-like"\] :is\(\s*\.term-assistant\.has-dot > \.term-assistant-dot\s*\)\s*\{([\s\S]*?)\n\}/,
    )?.[1] ?? ''
    const terminalToolIndicator = css.match(
      /\.app\[data-interface-mode="terminal-like"\] \.term-tool-head > \.term-tool-indicator\s*\{([\s\S]*?)\n\}/,
    )?.[1] ?? ''
    expect(terminalAssistantMarker).toContain('font-family: var(--msg-font,var(--chat-font,var(--mono)))')
    expect(terminalAssistantMarker).toContain('font-size: var(--msg-font-size,var(--chat-font-size,var(--font-size-lg)))')
    expect(terminalAssistantMarker).toContain('line-height: var(--msg-line-height,var(--chat-line-height,1.35))')
    expect(terminalToolIndicator).toContain('font-family: var(--msg-font, var(--chat-font, var(--mono)))')
    expect(terminalToolIndicator).toContain('font-size: var(--msg-font-size, var(--chat-font-size, var(--font-size-lg)))')
    expect(terminalToolIndicator).toContain('line-height: var(--msg-line-height, var(--chat-line-height, 1.35))')
  })

  it('uses the shared marker gutter for the streaming frame without a visual offset', () => {
    expect(css).toMatch(/\.term-spinner-row \.spinner-frame\s*\{[^}]*flex:0 0 var\(--dot-col-width,var\(--agent-marker-col,1\.6em\)\);[^}]*text-align:left;/s)
    expect(css).toMatch(/\.term-spinner-row\s*\{[^}]*margin-left:0;[^}]*transform:none;/s)
  })

  it('anchors empty-state brand and creation progress to the chat viewport', () => {
    expect(chromeCss).toMatch(/\.solid-workbench-empty-space\s*\{[^}]*align-items: flex-start;[^}]*min-height: 100%;/s)
    expect(chromeCss).toMatch(/\.solid-workbench-empty-brand\s*\{[^}]*position: absolute;[^}]*top: clamp\(10%, 8vh, 18%\);[^}]*display: flex;[^}]*justify-content: center;/s)
    expect(chromeCss).not.toMatch(/\.solid-workbench-empty-brand\s*\{[^}]*min-height: 100%;/s)
    expect(chromeCss).toMatch(/\.solid-workbench-creation-overlay-host\s*\{[^}]*position: absolute;[^}]*inset: 0 var\(--creation-overlay-right-inset\) 0 0;[^}]*place-items: center;/s)
    expect(chromeCss).toMatch(/\.solid-workbench-chat-shell\.solid-workbench-empty-chat-shell\s*\{[^}]*--creation-overlay-right-inset: 0px;/s)
    expect(chromeCss).toMatch(/\.solid-workbench-creation-overlay-host\[data-reduced-motion='true'\][^}]*\.solid-workbench-creation-progress-bar\s*\{[^}]*animation: none;/s)
  })

  it('centers the Solid logo independently of the adjacent wordmark', () => {
    const lockup = chromeCss.match(/\.solid-workbench-empty-brand \.agent-empty-lockup\s*\{([\s\S]*?)\n\}/)?.[1] ?? ''
    expect(lockup).toContain('display: grid')
    expect(lockup).toContain('grid-template-columns: minmax(0,1fr) 48px minmax(0,1fr)')
    expect(chromeCss).toMatch(/\.solid-workbench-empty-brand \.agent-empty-brand\s*\{[^}]*grid-column: 2;[^}]*justify-self: center;/s)
    expect(chromeCss).toMatch(/\.solid-workbench-empty-brand \.agent-empty-wordmark\s*\{[^}]*grid-column: 3;/s)
  })

  it('keeps the React empty surface full-width so its logo centers in the same viewport', () => {
    expect(css).toMatch(/\.chat-empty\s*\{[^}]*min-height:100%;[^}]*width:100%;/s)
    expect(css).toMatch(/\.chat-empty\.agent-empty-state\s*\{[^}]*position:relative;/s)
  })
})
