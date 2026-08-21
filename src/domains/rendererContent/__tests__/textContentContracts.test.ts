import { describe, expect, it } from 'vitest'
import {
  findOversizeFoldPoint,
  isClosedCodeFence,
  sanitizeAnsiForDisplay,
  stripAnsiControlSequences,
} from '../textContentContracts.ts'

/**
 * C00 RED：文本族内容契约（纯函数层，Solid/React 共用）。
 * 参考 claude-code-sourcemap：SGR 白名单解析（ink/termio/sgr.ts）、
 * OSC 剥离（osc.ts）、fence-aware 流式切分（streamingMarkdownSplit 已有）。
 */
describe('textContentContracts (C00)', () => {
  it('keeps allowed SGR styling and strips OSC/control sequences', () => {
    const spans = stripAnsiControlSequences('\u001b[31merr\u001b[0m plain \u001b]0;title\u0007tail')
    // 相邻无样式 span 合并为一个（OSC 剥离不产生视觉断点）
    expect(spans).toEqual([
      { text: 'err', fg: 'red' },
      { text: ' plain tail' },
    ])
  })

  it('supports named + bright colors, bold/dim/italic/underline and reset semantics', () => {
    const spans = stripAnsiControlSequences('\u001b[1;32mgreen-bold\u001b[22;39m after')
    expect(spans[0]).toEqual({ text: 'green-bold', fg: 'green', bold: true })
    // 22/39 只清除对应属性，不整段重置
    expect(spans[1]).toEqual({ text: ' after', fg: undefined, bold: undefined })
  })

  it('maps 256-color and truecolor SGR into css color values', () => {
    const spans = stripAnsiControlSequences('\u001b[38;5;208mc256\u001b[38;2;12;34;56mtc\u001b[0m!')
    // 208 = xterm 6×6×6 立方 (5,2,0) → #ff8700
    expect(spans[0]).toMatchObject({ text: 'c256', fgCss: '#ff8700' })
    expect(spans[1]).toMatchObject({ text: 'tc', fgCss: '#0c2238' })
    // 非 SGR 的 CSI 终止字节（如 RIS 'c'）整体剥离，不影响渲染
    const ris = stripAnsiControlSequences('safe\u001b[38;2;1;2;3cpayload')
    expect(ris.map(span => span.text).join('')).toBe('safepayload')
    expect(spans[2]?.text).toBe('!')
  })

  it('drops dangerous sequences: OSC hyperlinks, ESC-prefixed junk and C0 controls except newline/tab', () => {
    // OSC 8 超链接必须剥离（防链接注入），保留显示文本
    const link = stripAnsiControlSequences('\u001b]8;;https://evil.example\u0007click\u001b]8;;\u0007me')
    expect(link.map(span => span.text).join('')).toBe('clickme')
    expect(JSON.stringify(link)).not.toContain('evil.example')
    // C0 控制字符（除 \n \t）不进入渲染；字面文本完整保留
    const cleaned = stripAnsiControlSequences('a\u0007b\u000bc\n d\t e')
    expect(cleaned.map(span => span.text).join('')).toBe('abc\n d\t e')
  })

  it('sanitizeAnsiForDisplay returns safe html with escaped text and class-only styling', () => {
    const html = sanitizeAnsiForDisplay('<script>\u001b[31mx</script>\u001b[0m')
    // 文本被转义，脚本不可执行；着色只经 class
    expect(html).not.toContain('<script>')
    expect(html).toContain('term-ansi-fg-red')
  })

  it('detects closed code fences for streaming stability', () => {
    expect(isClosedCodeFence('```ts\nconst a = 1\n```')).toBe(true)
    expect(isClosedCodeFence('```ts\nconst a = 1')).toBe(false)
    expect(isClosedCodeFence('~~~\nhi\n~~~\nafter')).toBe(true)
    expect(isClosedCodeFence('no fence')).toBe(true)
  })

  it('finds oversize fold point keeping search-complete prefix and explicit truncation marker', () => {
    const long = 'x'.repeat(100)
    // 折叠点在行边界上（不劈开一行）
    const fold = findOversizeFoldPoint(long.repeat(100), 500)
    expect(fold).not.toBeNull()
    expect(fold!.visibleLength).toBeLessThanOrEqual(500)
    expect(long.repeat(100)[fold!.visibleLength - 1]).toBeDefined()
    // 短内容不折叠
    expect(findOversizeFoldPoint('short', 500)).toBeNull()
  })
})
