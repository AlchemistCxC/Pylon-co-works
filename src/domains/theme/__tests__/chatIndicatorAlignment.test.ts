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

/** 取完整规则块（大括号配平，支持 :is(...) 选择器与嵌套块）；起始锚点可为字符串或正则 */
function blockContaining(cssText: string, startMarker: string | RegExp): string {
  const index = typeof startMarker === 'string' ? cssText.indexOf(startMarker) : cssText.search(startMarker)
  if (index < 0) throw new Error(`缺少 ${startMarker}`)
  const open = cssText.indexOf('{', index)
  if (open < 0) throw new Error(`区块无开括号：${startMarker}`)
  let depth = 0
  for (let i = open; i < cssText.length; i++) {
    if (cssText[i] === '{') depth++
    else if (cssText[i] === '}') {
      depth--
      if (depth === 0) return cssText.slice(index, i + 1)
    }
  }
  throw new Error(`区块未闭合：${startMarker}`)
}

/** 归一化：去除全部空白后比较声明（书写格式与属性顺序不耦合） */
function compact(text: string): string {
  return text.replace(/\s+/g, '')
}

describe('chat indicator alignment contract', () => {
  it('keeps terminal-like assistant and tool markers in the same fixed left column（块内属性级断言，不耦合属性顺序）', () => {
    // 选择器存在性（文件级契约）
    expect(chatCss).toContain('.term-assistant.has-dot > .term-assistant-dot')
    expect(chatCss).toContain('.term-tool-head > .term-tool-indicator')
    // 助手 marker 区块：消息轨字体/字号 + 固定左列（属性级断言，与书写顺序无关）
    const markerBlock = compact(blockContaining(chatCss, /\.app\[data-interface-mode="terminal-like"\]\s*:is\(\s*\.term-assistant\.has-dot/))
    for (const declaration of [
      'font-family: var(--msg-font, var(--chat-font, var(--mono)))',
      'font-size: var(--msg-font-size, var(--chat-font-size, var(--font-size-lg)))',
      'line-height: var(--msg-line-height, var(--chat-line-height, 1.35))',
      'width: var(--dot-col-width, 1.6em)',
      'flex: 0 0 var(--dot-col-width, 1.6em)',
      'justify-content: flex-start',
      'text-align: left',
    ]) {
      expect(markerBlock).toContain(compact(declaration))
    }

    const toolIndicatorBlock = compact(blockContaining(chatCss, '.app[data-interface-mode="terminal-like"] .term-tool-head > .term-tool-indicator'))
    for (const declaration of [
      'justify-content: flex-start',
      'text-align: left',
      'font-family: var(--msg-font, var(--chat-font, var(--mono)))',
      'font-size: var(--msg-font-size, var(--chat-font-size, var(--font-size-lg)))',
      'line-height: var(--msg-line-height, var(--chat-line-height, 1.35))',
    ]) {
      expect(toolIndicatorBlock).toContain(compact(declaration))
    }
    expect(chatCss).not.toMatch(/\.app\[data-interface-mode="terminal-like"\][^{}]*\{[^}]*scale\s*:/s)
  })

  it('removes first-block top spacing through renderer slot wrappers', () => {
    expect(chatCss).toMatch(/\.term-assistant\.has-dot > \.term-assistant-body > :first-child\s*\{[^}]*margin-top\s*:\s*0\s*;/s)
    expect(chatCss).toContain('.term-assistant.has-dot > .term-assistant-body > :first-child > :first-child,')
    expect(chatCss).toMatch(/\.term-assistant\.has-dot > \.term-assistant-body > :first-child > :first-child > :first-child\s*\{[^}]*margin-top\s*:\s*0\s*;/s)
  })

  it('does not vertically offset the tool indicator from the assistant marker（块内属性级断言，不钉具体偏移值）', () => {
    // 所有涉及 .term-tool-indicator 的规则块都不得设置 margin-top（任何值都不行）
    for (const match of chatCss.matchAll(/([^{}]+)\{[^{}]*\}/g)) {
      if ((match[1] ?? '').includes('.term-tool-indicator')) {
        expect(match[0]).not.toContain('margin-top')
      }
    }
  })

  it('pins assistant and tool markers to the same chat-rail typography in every interface mode', () => {
    // 指示器字号契约：助手标记与工具指示器同字体同字号（否则槽位渲染器的
    // 局部字号覆盖会静默缩小工具字形 —— 真实应用与开发模式不一致的根因）。
    expect(chatCss).toMatch(
      /\.term-assistant\.has-dot > \.term-assistant-dot,\s*\.term-tool-indicator\s*\{[^}]*font-family\s*:\s*var\(--msg-font,\s*var\(--chat-font,\s*var\(--mono\)\)\)\s*;[^}]*font-size\s*:\s*var\(--msg-font-size,\s*var\(--chat-font-size,\s*var\(--font-size-lg\)\)\)\s*;/s,
    )
    // 槽位渲染器不得再用更高特异性的 inherit 链覆盖契约
    expect(chatCss).not.toContain('.solid-tool-invocation .term-tool-indicator')
  })

  it('keeps ordered-list markers inside the reasoning scroll port', () => {
    expect(chatCss).toMatch(/\.term-reasoning-body\s+:is\(ol,ul\)\s*\{[^}]*padding-inline-start\s*:\s*2em\s*;/s)
  })

  it('pins the streaming accent bar to the message rail left edge', () => {
    // 用户确认的左对齐口径：流式特效竖条与消息行左缘对齐，不伸出行外
    // （此前 inset 左侧 -6px 使竖条悬在行外，视觉略偏左）。
    expect(chatCss).toMatch(/\.term-row-assistant\[data-streaming="true"\]::after,\s*\.term-row-reasoning\[data-streaming="true"\]::after,\s*\.plain-message-list__row\[data-streaming="true"\] \.term-row-assistant::after\s*\{[^}]*inset\s*:\s*0 auto 0 0\s*;/s)
  })
})
