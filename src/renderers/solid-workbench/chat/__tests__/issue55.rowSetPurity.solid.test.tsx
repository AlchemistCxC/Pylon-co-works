// @vitest-environment jsdom
import { cleanup, render, waitFor } from '@solidjs/testing-library'
import { createSignal } from 'solid-js'
import { afterEach, describe, expect, it } from 'vitest'
import { MarkdownContent } from '../MarkdownContent.solid.tsx'
import { splitStreamingMarkdownBlocks } from '../streamingMarkdownSplit.ts'

afterEach(cleanup)

/**
 * 行元素文本：容器直接子元素 = 行渲染出的顶层块。
 * 注意一个「行」在解析路径下可能产出多个顶层元素（例如标题紧跟段落），所以这里读的是元素文本。
 */
function blockTexts(container: HTMLElement): string[] {
  return [...container.children].map(element => element.textContent ?? '')
}

/** 块签名：标签 + class + 文本。用于「流式结果 == 对同一文本的直接推导（全新挂载）」的逐块比对。 */
function blockSignature(container: HTMLElement): string[] {
  return [...container.children].map(element => `${element.tagName}.${element.className}|${element.textContent ?? ''}`)
}

function hasStructuralEdgeWhitespace(text: string): boolean {
  return /^\s/.test(text) || /\s$/.test(text)
}

/** 无文本的顶层块的标签 + class（定位用：空文本块要么是结构元素，要么是缺陷）。 */
function emptyBlockSignature(container: HTMLElement): string[] {
  return [...container.children]
    .filter(element => (element.textContent ?? '').length === 0)
    .map(element => `${element.tagName}.${getBlockClass(element)}`)
}

function getBlockClass(element: Element): string {
  return typeof element.className === 'string' ? element.className : ''
}

/** 文本段落数（与实现同一把尺：切分器的稳定块 + 非空尾块）。 */
/** 带结构首尾空白的块（截断显示便于定位）。 */
function edgeWhitespaceBlocks(container: HTMLElement): string[] {
  return blockTexts(container)
    .filter(text => hasStructuralEdgeWhitespace(text))
    .map(text => (text.length > 60 ? `${JSON.stringify(text.slice(0, 30))}…${JSON.stringify(text.slice(-30))}` : JSON.stringify(text)))
}

/**
 * 纯空白块（任何形式）：行文本要么有内容，要么不渲染——空白块永远是缺陷。
 * 注意不能用 `/^\s/` 判定「结构空白」：源文本里的代码缩进是内容，解析后的表格/列表元素
 * 之间也夹着渲染标记自身的换行，两者都不属于行文本。
 */
function blankBlocks(container: HTMLElement): string[] {
  return [...container.children]
    .filter(element => (element.textContent ?? '').trim().length === 0)
    .map(element => `${element.tagName}.${getBlockClass(element)}`)
}

/** 直排文本行（走纯文本快路径的 <p>）里的结构前导空行——历史 `'\n\n快'` 泄漏的形状。 */
function plainRowsWithLeadingBlankLine(container: HTMLElement): string[] {
  return [...container.querySelectorAll<HTMLElement>('p.term-plain-text')]
    .map(element => element.textContent ?? '')
    .filter(text => /^\s*\n/.test(text))
}

function paragraphCount(text: string): number {
  const split = splitStreamingMarkdownBlocks(text)
  return split.stableBlocks.length + (split.unstable.length > 0 ? 1 : 0)
}

/**
 * issue #55 现场文本的**形状**（不是原文：真机那条思考文本含用户私人画像内容，本仓库公开，
 * 故不入库）。数值取自该轮 journal 实测：6847 字 / 144 换行 / 55 个空行对，段落以单行汉语
 * 思考为主，中间夹一段缩进围栏代码、一张表格与中英混排的长句。
 */
function issue55ShapedText(): string {
  const paragraphs: string[] = []
  for (let index = 0; index < 18; index += 1) {
    paragraphs.push(`第 ${index + 1} 段：先确认现象与复现路径，再核对渲染层的宽度来源与揭示节奏，最后把结论登记到台账。`)
  }
  paragraphs.push([
    '形式检查（缩进围栏）：',
    '',
    '    ```ts',
    '    const rows = deriveRowSpecs(visible, final)',
    '    const split = splitStreamingMarkdownBlocks(visible)',
    '    ```',
  ].join('\n'))
  paragraphs.push([
    '| 位置 | 谱 | 本例 | 合 |',
    '| --- | --- | --- | --- |',
    '| 一 | 仄仄平平仄仄平 | 示例句甲 | ✓ |',
    '| 二 | 平平仄仄仄平平 | 示例句乙 | ✓ |',
  ].join('\n'))
  for (let index = 0; index < 20; index += 1) {
    paragraphs.push(`尾段 ${index + 1}：Also a mixed sentence with latin words and 汉字 together to keep the wrap opportunities realistic.`)
  }
  return paragraphs.join('\n\n')
}

/** 按真机到达节奏把文本切片：每片 2-7 字，切点落在词中间（token 边界），够逼真。 */
function chunkSchedule(text: string, sizes: readonly number[]): string[] {
  const prefixes: string[] = []
  let offset = 0
  let index = 0
  while (offset < text.length) {
    offset = Math.min(text.length, offset + sizes[index % sizes.length]!)
    prefixes.push(text.slice(0, offset))
    index += 1
  }
  return prefixes
}

const SIZES = [3, 2, 5, 1, 4, 2, 7, 3, 2, 6] as const

describe('issue 55: 行文本不变式', () => {
  it('尾块的前导分隔空行不进入行文本（历史 \\n\\n快 残留）', async () => {
    // 发布 1 先把首个块提交掉（committedText 停在该块末尾）。
    const [text, setText] = createSignal('A\n\n')
    const { container } = render(() => <MarkdownContent text={text()} streaming />)
    await waitFor(() => expect(container.textContent).toContain('A'))

    // 发布 2 的 pending 正好以空行开头：旧实现只在「本轮命中稳定块」时才裁前导分隔，
    // 于是把 '\n\n快' 整段当成行文本，渲染成先空一行再输出几个字（真机快照里的 '\n\n快'）。
    setText('A\n\n\n\n快')
    await waitFor(() => expect(container.textContent).toContain('快'))

    const blocks = blockTexts(container)
    expect(blocks.length).toBeGreaterThan(0)
    expect(blocks.every(block => block.length > 0)).toBe(true)
    expect(blocks.some(block => block.startsWith('\n'))).toBe(false)
    expect(blocks.every(block => !hasStructuralEdgeWhitespace(block))).toBe(true)
    expect(blocks.join('|')).toContain('快')
  })

  it('纯结构空白的尾块不渲染为空行', async () => {
    const [text, setText] = createSignal('A')
    const { container } = render(() => <MarkdownContent text={text()} streaming />)
    await waitFor(() => expect(container.textContent).toContain('A'))

    setText('A\n\n ')
    await waitFor(() => expect(container.textContent).toContain('A'))

    const blocks = blockTexts(container)
    expect(blocks.every(block => block.length > 0)).toBe(true)
  })
})

describe('issue 55: 行集合是当前文本的纯函数', () => {
  it('回退 / 换挡 / 终态重发之后，行集合等于对同一文本的直接推导', async () => {
    const finalText = '第一段已经完成。\n\n第二段正在增长，尚未结束'
    const [text, setText] = createSignal(finalText)
    const { container } = render(() => <MarkdownContent text={text()} streaming />)
    await waitFor(() => expect(container.textContent).toContain('第二段正在增长'))
    // 基线：单调增长到该文本时的行集合（同一渲染路径，可比）。等异步解析落地（.term-md-skeleton
    // 消失）再取，否则比的是两个都还在解析的中间态。
    await waitFor(() => expect(emptyBlockSignature(container)).toEqual([]))
    const baseline = blockSignature(container)

    // 发布链可能出现非后继输入（插值后的裁剪前缀、双列表分叉、终态重发、resume）：
    // 这里显式制造「回退 → 换挡到别的文本 → 回到目标文本 → 追加结构空白 → 再回目标文本」。
    // 行集合是当前文本的函数 ⇒ 同一文本必须得到与基线相同的行集合；旧实现的累积行集合
    // 会在这里留下文本里不存在的边界（便是碎片化的来源）。
    setText('第一段已经完成。\n\n第二')
    setText('另一段完全不同的内容，用来制造一次换挡。')
    setText(finalText)
    setText(`${finalText}\n\n `)
    setText(finalText)
    await waitFor(() => expect(blockSignature(container)).toEqual(baseline))
    await waitFor(() => expect(emptyBlockSignature(container)).toEqual([]))

    const blocks = blockTexts(container)
    expect(blocks.every(block => block.length > 0)).toBe(true)
    expect(edgeWhitespaceBlocks(container)).toEqual([])
    expect(blocks.length).toBeLessThanOrEqual(paragraphCount(finalText))
  })

  it('终态后重复发布同一文本不再新增块（幂等）', async () => {
    const finalText = '甲段。\n\n乙段。\n\n丙段'
    const [state, setState] = createSignal({ text: finalText, streaming: true })
    const { container } = render(() => <MarkdownContent text={state().text} streaming={state().streaming} />)
    await waitFor(() => expect(container.textContent).toContain('丙段'))

    setState({ text: finalText, streaming: false })
    await waitFor(() => expect(container.textContent).toContain('丙段'))
    const settled = blockSignature(container)
    expect(settled.length).toBeLessThanOrEqual(paragraphCount(finalText))

    // 终态后再发布两次（含一次等值重发与一次先增加后复原的空白），行集合必须不变。
    setState({ text: finalText, streaming: false })
    setState({ text: `${finalText}\n\n `, streaming: false })
    setState({ text: finalText, streaming: false })
    await waitFor(() => expect(blockSignature(container)).toEqual(settled))
  })
})

describe('issue 55: 现场形状回归（真机规模与切分节奏）', () => {
  it('55 段规模 + token 级切片：同文本同结果、块数不超段落数、无结构边界空白', async () => {
    const full = issue55ShapedText()
    expect(paragraphCount(full)).toBeGreaterThanOrEqual(40)

    const prefixes = chunkSchedule(full, SIZES)
    const [text, setText] = createSignal(prefixes[0] ?? '')
    const { container } = render(() => <MarkdownContent text={text()} streaming />)

    for (const prefix of prefixes) setText(prefix)
    await waitFor(() => expect(container.textContent).toContain('尾段 20'))
    // 等所有行的异步解析落地（.term-md-skeleton 是解析中的合法加载态，不是空块缺陷）。
    await waitFor(() => expect(emptyBlockSignature(container)).toEqual([]))
    const settled = blockSignature(container)

    // 非后继输入（回退到中段）再回到全文：同文本必须得到同一行集合。
    setText(full.slice(0, Math.floor(full.length / 2)))
    setText(full)
    await waitFor(() => expect(emptyBlockSignature(container)).toEqual([]))
    await waitFor(() => expect(blockSignature(container)).toEqual(settled))

    const blocks = blockTexts(container)
    expect(blocks.length).toBeGreaterThan(0)
    expect(blocks.length).toBeLessThanOrEqual(paragraphCount(full))
    expect(emptyBlockSignature(container)).toEqual([])
    expect(blankBlocks(container)).toEqual([])
    expect(plainRowsWithLeadingBlankLine(container)).toEqual([])
  })
})
