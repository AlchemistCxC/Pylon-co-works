// @vitest-environment jsdom
/**
 * issue #150 · 稳定性：增量只允许影响「正在长的那一行」，绝不允许影响已提交内容与别的行。
 *
 * 三条不变式：
 * 1. **提升即全量（自愈）**：块完成、该行被提升为稳定行时，资源换源重解析一次 ⇒ 已提交内容来自
 *    整段重解析。即便某个没预料的形状上拼错了，也会在块完成那一刻被真实解析覆盖。
 * 2. **同文本同结果**：带拼接的流式结果 == 一次性流式挂载（基座为空 ⇒ 全程整段重解析）的逐块结果。
 * 3. **多行不串味**：两个实例共享基座 MRU 并交替增长时，各自仍等于自己的一次性挂载结果。
 *
 * 比较基准必须是**同路径的流式挂载**：非流式（已提交消息）路径走的是另一套渲染模型（纯文本整段
 * 直排、不带 `term-plain-text` 类），那是 #55 时代的既有契约，不是本 issue 的比对对象。
 */
import { cleanup, render, waitFor } from '@solidjs/testing-library'
import { createSignal } from 'solid-js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MarkdownContent } from '../MarkdownContent.solid.tsx'
import { clearMarkdownRenderModelCache } from '../markdownRenderModel.ts'
import { markdownParseCounters, resetMarkdownParseCounters } from '../markdownParseCounters.ts'

beforeEach(() => {
  clearMarkdownRenderModelCache()
  resetMarkdownParseCounters()
})

afterEach(cleanup)

const nextFrame = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))

/** 块签名：标签 + class + 文本（与 #55 用例同口径）。 */
function blockSignature(container: HTMLElement): string[] {
  return [...container.children].map(element => `${element.tagName}.${element.className}|${element.textContent ?? ''}`)
}

/** 一次性流式挂载（基座为空 ⇒ 不会发生拼接），作为比对基准。 */
async function oneShotStreamingBaseline(text: string): Promise<readonly string[]> {
  clearMarkdownRenderModelCache()
  const view = render(() => <MarkdownContent text={text} streaming />)
  await waitFor(() => expect(view.container.textContent).toBeTruthy())
  await nextFrame()
  return blockSignature(view.container)
}

describe('issue 150 · 稳定性：提升即全量（自愈）', () => {
  it('尾块被提升为稳定行时换源整段重解析一次，结果与一次性挂载逐块相同', async () => {
    // 段落块（标记在开头、后面是长纯文本）：既能发生拼接，又会在空行处被 splitter 判为块完成。
    // 注意列表块**不会**在空行处完成（列表可以有 lazy continuation，整块是一行）——它的提升只发生在终态。
    const head = '**粗体**后面是一长串没有任何标点符号的中文内容继续往下写直到最后'
    const tailText = '尾段收尾'
    const full = `${head}\n\n${tailText}`
    const [state, setState] = createSignal({ text: '', streaming: true })
    const view = render(() => <MarkdownContent text={state().text} streaming={state().streaming} />)

    for (let end = 1; end <= head.length; end += 1) {
      setState({ text: head.slice(0, end), streaming: true })
      await nextFrame()
    }
    await waitFor(() => expect(view.container.textContent).toContain('继续往下写直到最后'))
    const graftedAtHead = markdownParseCounters().grafted
    const parsedAtHead = markdownParseCounters().parsed
    expect(graftedAtHead, '纯文本追加应当发生拼接').toBeGreaterThan(0)

    // 空行 ⇒ 段落块完成 ⇒ 该行被提升为稳定行 ⇒ 换源整段重解析一次（自愈）
    setState({ text: `${head}\n\n`, streaming: true })
    await nextFrame()
    expect(markdownParseCounters().parsed, '提升应当触发一次整段重解析').toBeGreaterThan(parsedAtHead)

    setState({ text: full, streaming: true })
    await waitFor(() => expect(view.container.textContent).toContain(tailText))
    setState({ text: full, streaming: false })
    await waitFor(() => expect(view.container.textContent).toContain(tailText))
    expect(blockSignature(view.container)).toEqual(await oneShotStreamingBaseline(full))
  })
})

describe('issue 150 · 稳定性：同文本同结果（含拼接 vs 无拼接）', () => {
  it('带行内标记与列表的文本：流式（发生拼接）与一次性流式挂载逐块相同', async () => {
    const text = [
      '第一段含 `行内代码` 与 **强调** 的正文',
      '',
      '- 列表项甲',
      '- 列表项乙',
      '- 列表项丙',
      '',
      '尾段收尾',
    ].join('\n')

    const [state, setState] = createSignal({ text: '', streaming: true })
    const view = render(() => <MarkdownContent text={state().text} streaming={state().streaming} />)
    for (let end = 2; end <= text.length; end += 2) {
      setState({ text: text.slice(0, end), streaming: true })
      await nextFrame()
    }
    setState({ text, streaming: true })
    await waitFor(() => expect(view.container.textContent).toContain('尾段收尾'))
    expect(markdownParseCounters().grafted, '应当发生过拼接').toBeGreaterThan(0)

    expect(blockSignature(view.container)).toEqual(await oneShotStreamingBaseline(text))
  })
})

describe('issue 150 · 稳定性：多行并发不串味', () => {
  it('两个实例交替增长（共享基座 MRU），各自与一次性挂载逐块相同且互不泄漏', async () => {
    const leftText = '甲组第一段文字\n甲组第二段文字\n\n- 甲组列表'
    const rightText = '甲组第一段文字\n乙组第二段文字\n\n- 乙组列表' // 前缀与左实例长时间重合
    const [left, setLeft] = createSignal({ text: '', streaming: true })
    const [right, setRight] = createSignal({ text: '', streaming: true })
    const leftView = render(() => <MarkdownContent text={left().text} streaming={left().streaming} />)
    const rightView = render(() => <MarkdownContent text={right().text} streaming={right().streaming} />)

    for (let end = 2; end <= Math.min(leftText.length, rightText.length); end += 2) {
      setLeft({ text: leftText.slice(0, end), streaming: true })
      setRight({ text: rightText.slice(0, end), streaming: true })
      await nextFrame()
    }
    setLeft({ text: leftText, streaming: true })
    setRight({ text: rightText, streaming: true })
    await waitFor(() => expect(leftView.container.textContent).toContain('甲组列表'))
    await waitFor(() => expect(rightView.container.textContent).toContain('乙组列表'))

    expect(blockSignature(leftView.container)).toEqual(await oneShotStreamingBaseline(leftText))
    expect(blockSignature(rightView.container)).toEqual(await oneShotStreamingBaseline(rightText))
    expect(leftView.container.textContent).not.toContain('乙组')
    expect(rightView.container.textContent).not.toContain('甲组列表')
  })
})
