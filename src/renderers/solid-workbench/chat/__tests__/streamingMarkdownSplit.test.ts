import { describe, expect, it } from 'vitest'
import { findLastStableBlockBoundary, splitStreamingMarkdown } from '../streamingMarkdownSplit.ts'

describe('findLastStableBlockBoundary / splitStreamingMarkdown', () => {
  it('单段文本：尾部即不稳定区，stable 为空', () => {
    const { stable, unstable } = splitStreamingMarkdown('正在回复的一段话')
    expect(stable).toBe('')
    expect(unstable).toBe('正在回复的一段话')
  })

  it('完整多块：最后一个空行为边界，前一整块进 stable', () => {
    const text = '第一行\n\n第二行片段'
    const { stable, unstable } = splitStreamingMarkdown(text)
    expect(stable).toBe('第一行\n\n')
    expect(unstable).toBe('第二行片段')
  })

  it('多块再次增长：稳定前缀只前进不后退', () => {
    const t1 = 'A\n\nB'
    const t2 = 'A\n\nBBB'
    const s1 = splitStreamingMarkdown(t1)
    const s2 = splitStreamingMarkdown(t2)
    // 稳定部分保持"A\n\n"不变（单调），只尾部增长
    expect(s1.stable).toBe('A\n\n')
    expect(s2.stable).toBe('A\n\n')
    expect(s1.unstable).toBe('B')
    expect(s2.unstable).toBe('BBB')
  })

  it('代码围栏未闭合：整段进 unstable（不劈开围栏），围栏闭合后才进 stable', () => {
    // 未闭合围栏 → 整个都在 unstable
    const open = splitStreamingMarkdown('头部\n\n```js\nconst x = 1')
    expect(open.unstable).toContain('```js')

    // 围栏闭合后：围栏成为已完成块，进 stable；之后新起的片段进 unstable
    const closed = splitStreamingMarkdown('头部\n\n```js\nconst x = 1\n```\n\n新的片段继续')
    expect(closed.stable).toContain('```js')
    expect(closed.stable).toContain('```')
    expect(closed.unstable).toBe('新的片段继续')
  })

  it('列表/标题块也按空行稳定化', () => {
    const text = '- 项1\n- 项2\n\n新段落开始'
    const { stable, unstable } = splitStreamingMarkdown(text)
    expect(stable).toContain('- 项1')
    expect(unstable).toBe('新段落开始')
  })

  it('识别带缩进的围栏，且较短或带尾随文本的 marker 不能伪闭合', () => {
    const text = '前文\n\n  ````js\nconst a = 1\n```\n```still-code\n\nconst b = 2'
    const { stable, unstable } = splitStreamingMarkdown(text)
    expect(stable).toBe('前文\n\n')
    expect(unstable).toContain('const a = 1')
    expect(unstable).toContain('const b = 2')
  })

  it('CRLF 空行边界不会把回车留在 unstable', () => {
    expect(splitStreamingMarkdown('第一段\r\n\r\n第二段')).toEqual({
      stable: '第一段\r\n\r\n',
      unstable: '第二段',
    })
  })

  it('空字符串边界为 0', () => {
    expect(findLastStableBlockBoundary('')).toBe(0)
    expect(splitStreamingMarkdown('')).toEqual({ stable: '', unstable: '' })
  })
})
