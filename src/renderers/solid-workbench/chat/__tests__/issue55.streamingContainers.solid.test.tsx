// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from '@solidjs/testing-library'
import { createSignal } from 'solid-js'
import { afterEach, describe, expect, it } from 'vitest'
import { ReasoningBlock } from '../MessageRow.solid.tsx'
import { mountSolidWorkbench } from '../../mountSolidWorkbench.solid.tsx'
import { createPreviewWorkbenchServices } from '../../__fixtures__/previewWorkbenchServices.ts'
import { createWorkbenchEnvelope, type WorkbenchEventEnvelope } from '../../../../domains/workbench/events/workbenchEventSchema.ts'
import { projectWorkbench } from '../../../../domains/workbench/workbenchProjector.ts'

afterEach(cleanup)

describe('issue 55: streaming Markdown retains container context', () => {
  it('preserves list prose through canonical projection and the production content Slot', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    const services = createPreviewWorkbenchServices()
    const mounted = mountSolidWorkbench({ host, input: { sheetId: 'issue55', sessionId: 'preview-session', preview: true }, services })
    try {
      const events: WorkbenchEventEnvelope[] = []
      for (const [index, text] of ['前文\n\n', '1. **检查**\n\n', '    **先看**\n', '    增量\n    正文。'].entries()) {
        events.push(createWorkbenchEnvelope({
          sessionId: 'preview-session', sequence: index + 1,
          recordedAt: new Date(index * 1000).toISOString(),
          source: { provider: 'acp', sourceId: `issue55-${index}` },
          identity: { messageId: 'reasoning-55' },
          provenance: { origin: 'local-observed', trust: 'authoritative' },
          event: { type: 'reasoning.delta', parts: [{ kind: 'text', text }] },
        }))
        services.runtime.replaceDocument(projectWorkbench(events).document, { ownerKey: 'issue55', generation: 1 })
        await new Promise(resolve => setTimeout(resolve, 0))
      }
      const head = await waitFor(() => {
        const button = host.querySelector<HTMLButtonElement>('.term-reasoning-head')
        expect(button).not.toBeNull()
        return button!
      })
      fireEvent.click(head)
      await waitFor(() => expect(host.querySelector('li p:last-child')).toHaveTextContent('增量 正文。'))
      expect(host.querySelector('.term-code-block')).toBeNull()
      expect(host.querySelectorAll('.term-reasoning-body')).toHaveLength(1)
    } finally {
      mounted.destroy()
      services.destroy()
      host.remove()
    }
  })

  it.each(['\n', '\r\n'])('keeps indented list prose out of the code renderer (%j)', async newline => {
    const prefix = '# 已稳定的前文\n\n'
    const continuation = '1. **检查状态**\n\n    **先看**\n    增量\n    内容，\n    再检查\n    布局。\n\n2. **验证结果**\n\n    保留列表续写。'
    const fullText = (prefix + continuation).replaceAll('\n', newline)
    const [text, setText] = createSignal(prefix.replaceAll('\n', newline))
    const [running, setRunning] = createSignal(true)
    const live = render(() => <ReasoningBlock text={text()} running={running()} />)
    fireEvent.click(live.getByRole('button'))
    const heading = await waitFor(() => live.getByRole('heading'))

    // Yield at each wire fragment: a synchronous loop alone hides async parser transitions.
    for (let length = text().length; length < fullText.length; length += 7) {
      setText(fullText.slice(0, length + 7))
      await new Promise(resolve => setTimeout(resolve, 0))
    }
    await waitFor(() => expect(live.container).toHaveTextContent('保留列表续写。'))
    expect(live.container.querySelectorAll('.term-code-line')).toHaveLength(0)
    expect(live.container.querySelectorAll('ol')).toHaveLength(1)
    expect(live.container.querySelectorAll('li p')).toHaveLength(4)
    expect(live.getByRole('heading')).toBe(heading)

    setRunning(false)
    const replay = render(() => <ReasoningBlock text={fullText} running={false} defaultCollapsed={false} />)
    await waitFor(() => expect(replay.container.querySelectorAll('li p')).toHaveLength(4))
    const listHtml = (container: HTMLElement) => container.querySelector('ol')?.outerHTML
    expect(listHtml(live.container)).toBe(listHtml(replay.container))
    expect(live.getByRole('heading')).toBe(heading)
  })

  it.each([
    ['nested list', '- **父项**\n\n  - **子项**\n\n    子项续写。', 'ul ul'],
    ['blockquote', '> **引用**\n\n> 续写引用。', 'blockquote'],
    ['nested fence', '- **代码示例**\n\n  ```ts\n  const value = 1', 'li .term-code-block'],
  ])('matches replay structure for %s', async (_name, text, selector) => {
    const live = render(() => <ReasoningBlock text={text} running defaultCollapsed={false} />)
    const replay = render(() => <ReasoningBlock text={text} running={false} defaultCollapsed={false} />)
    await waitFor(() => {
      expect(live.container.querySelector(selector)).not.toBeNull()
      expect(replay.container.querySelector(selector)).not.toBeNull()
    })
    const bodyHtml = (container: HTMLElement) => container.querySelector('.term-reasoning-body')?.innerHTML
    expect(bodyHtml(live.container)).toBe(bodyHtml(replay.container))
  })
})
