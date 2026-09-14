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

  it('keeps an animated reasoning collapse region at the message width', () => {
    const region = css.match(/\.term-collapse,\s*\n\.term-collapse-content\s*\{([^}]*)\}/)?.[1] ?? ''
    expect(region).toContain('width:100%')
    expect(region).toContain('min-width:0')

    const body = css.match(/\.term-reasoning-body\s*\{([\s\S]*?)\n\}/)?.[1] ?? ''
    expect(body).toContain('box-sizing:border-box')
    expect(body).toContain('width:100%')
    expect(body).toContain('max-width:100%')
    expect(body).toContain('min-width:0')
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

    const messageRailRule = css.lastIndexOf('.term-tool-head,\n.term-tool-name')
    const codeSummaryRule = css.lastIndexOf('.term-tool-summary-code {')
    expect(messageRailRule).toBeGreaterThan(-1)
    expect(codeSummaryRule).toBeGreaterThan(messageRailRule)
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

  it('centers the complete Solid logo lockup as one visible unit', () => {
    const lockup = chromeCss.match(/\.solid-workbench-empty-brand \.agent-empty-lockup\s*\{([\s\S]*?)\n\}/)?.[1] ?? ''
    expect(lockup).toContain('display: inline-flex')
    expect(lockup).toContain('width: max-content')
    expect(lockup).toContain('max-width: 100%')
    expect(chromeCss).toMatch(/\.solid-workbench-empty-brand \.agent-empty-brand\s*\{[^}]*flex: 0 0 48px;/s)
    expect(chromeCss).toMatch(/\.solid-workbench-empty-brand \.agent-empty-wordmark\s*\{[^}]*max-width: calc\(100% - 48px - var\(--ui-space-2\)\);/s)
  })

  it('keeps the React empty surface full-width so its logo centers in the same viewport', () => {
    expect(css).toMatch(/\.chat-empty\s*\{[^}]*min-height:100%;[^}]*width:100%;/s)
    expect(css).toMatch(/\.chat-empty\.agent-empty-state\s*\{[^}]*position:relative;/s)
  })

  // P57 S3-R1（R-B1）：代码块内容 span 统一「保留缩进 + 长行软折」。
  it('P57 S3-R1：.term-code-block .term-code-text 的 pre-wrap+anywhere 规则存在', () => {
    const block = css.match(/\.term-code-block \.term-code-text\s*\{([^}]*)\}/)?.[1] ?? ''
    expect(block).toContain('white-space: pre-wrap')
    expect(block).toContain('overflow-wrap: anywhere')
    expect(block).toContain('min-width: 0')
    expect(block).toContain('flex: 1 1 auto')
  })

  // P57 S3-R5（R-B5）：user 正文双路径同 white-space 契约——元素+类双写选择器
  // 用于捕获第三方 Suite 渲染的裸 <p>。
  it('P57 S3-R5：.term-user p 与 .term-user .term-p 同为 pre-wrap', () => {
    expect(css).toMatch(/\.term-user p,\s*\n\.term-user \.term-p\s*\{\s*white-space: pre-wrap;\s*\}/)
  })

  // P57 S3-R8（R-B8/A11）：首次解析骨架的最小高度契约（配合零高度阶跃目标）。
  it('P57 S3-R8：.term-md-skeleton 解析骨架 min-height:1em 规则存在', () => {
    expect(css).toMatch(/\.term-md-skeleton\s*\{[^}]*min-height:\s*1em;/)
  })
})

// 真浏览器实测（Chrome headless 1280px，直接加载本文件；探针与数据见台账 P85）：
// `data-msg-style="bubble"`（行 shrink-to-fit）+ `data-message-layout="classic"`
// （正文零 basis）+ assistantDot 三者同开时，正文被压成 row=44px / body=0px /
// 91 行（同一段落其余组合均 3 行）——这正是「输出少数几个字符就换行」的碎裂。
describe('assistant body width contract', () => {
  it('keeps a shrink-to-fit bubble row out of the zero-basis assistant body rule', () => {
    // 前提：气泡行的宽度来自 msg-style（与 message-layout 无关）；内建预设
    // terminal-modern 恰好是 bubble + classic + assistantDot 三者同开。
    const bubbleRow = css.match(/\.app\[data-msg-style="bubble"\] \.term-row-user,[\s\S]*?width:fit-content/)?.[0] ?? ''
    expect(bubbleRow).toContain('width:fit-content')

    // 守卫必须排除气泡行，否则零 basis 会在 shrink-to-fit 行里塌成标记列宽。
    const zeroBasis = css.match(/\.app\[data-message-layout="classic"\][^{]*\.term-assistant\.has-dot > \.term-assistant-body\s*\{[^}]*\}/)?.[0] ?? ''
    expect(zeroBasis).toContain('flex:1 1 0')
    expect(zeroBasis).toContain('width:0')
    expect(zeroBasis).toContain(':not([data-msg-style="bubble"])')

    // 非气泡行仍走内容驱动的基础规则（588 行给 flex/min-width，2144 行给
    // width:auto/max-width:100%；后者正是气泡行回落的那一条）。
    const widthAutoRule = css.match(/\.term-assistant\.has-dot > \.term-assistant-body\s*\{([^}]*width:auto;[^}]*)\}/)?.[1] ?? ''
    expect(widthAutoRule).toContain('flex:1 1 auto')
    expect(widthAutoRule).toContain('max-width:100%')
  })
})
