// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from '@solidjs/testing-library'
import { createSignal } from 'solid-js'
import { afterEach, describe, expect, it } from 'vitest'
import { ReasoningBlock } from '../MessageRow.solid.tsx'
import { mountSolidWorkbench } from '../../mountSolidWorkbench.solid.tsx'
import { createPreviewWorkbenchServices } from '../../__fixtures__/previewWorkbenchServices.ts'
import { createWorkbenchEnvelope, type WorkbenchEventEnvelope } from '../../../../domains/workbench/events/workbenchEventSchema.ts'
import { createWorkbenchDocument, projectWorkbench } from '../../../../domains/workbench/workbenchProjector.ts'
import { normalizeHermesEvent } from '../../../../domains/workbench/normalizers/hermesNormalizer.ts'

afterEach(() => cleanup())

describe('issue 5 reasoning segmentation regression', () => {
  it('renders a character-at-a-time reasoning stream without extra paragraphs', async () => {
    const [text, setText] = createSignal('')
    const result = render(() => <ReasoningBlock text={text()} running />)
    for (const char of '这是一个连续的思考过程，不应该每几个字符换段。') setText(current => current + char)
    await waitFor(() => expect(result.container.textContent).toContain('不应该每几个字符换段'))
    expect(result.container.querySelectorAll('p')).toHaveLength(1)
  })

  it('keeps intentional Markdown blank-line paragraphs intact', async () => {
    const result = render(() => <ReasoningBlock text={'**第一段思考。**\n\n第二段思考。'} running={false} defaultCollapsed={false} />)
    await waitFor(() => expect(result.container.textContent).toContain('第二段思考'))
    await waitFor(() => expect(result.container.querySelectorAll('p')).toHaveLength(2))
  })

  it('canonical reasoning character deltas remain one paragraph', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    const services = createPreviewWorkbenchServices()
    const events: WorkbenchEventEnvelope[] = []
    const text = '这是一个连续的思考过程，不应该每几个字符换段。'
    for (const [index, char] of [...text].entries()) {
      const sequence = index + 1
      events.push(createWorkbenchEnvelope({
        sessionId: 'preview-session', sequence,
        recordedAt: `2026-08-25T00:00:${String(sequence).padStart(2, '0')}.000Z`,
        source: { provider: 'peri', sourceId: `reasoning-${sequence}` },
        identity: { messageId: `reasoning-${sequence}` },
        provenance: { origin: 'local-observed', trust: 'authoritative' },
        event: { type: 'reasoning.delta', parts: [{ kind: 'markdown', text: char }] },
      }))
    }
    mountSolidWorkbench({ host, input: { sheetId: 'sheet-a', sessionId: 'preview-session', preview: true }, services })
    services.runtime.replaceDocument(projectWorkbench(events).document, { ownerKey: 'owner-preview', generation: 1 })
    const button = await waitFor(() => host.querySelector<HTMLButtonElement>('.term-reasoning-head'))
    expect(button).not.toBeNull()
    fireEvent.click(button!)
    await waitFor(() => expect(host.textContent).toContain(text))
    const body = host.querySelector('.term-reasoning-body')!
    expect(body.querySelectorAll('p')).toHaveLength(1)
    services.destroy()
    host.remove()
  })

  it('Hermes thought chunks keep one semantic reasoning part after projection', () => {
    const text = '这是一个连续的思考过程，不应该每几个字符换段。'
    const events: WorkbenchEventEnvelope[] = []
    for (const [index, char] of [...text].entries()) {
      const sequence = index + 1
      const normalized = normalizeHermesEvent({
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: char },
      }, {
        provider: 'hermes', sessionId: 'preview-session', sourceId: `thought-${sequence}`,
        sequence, recordedAt: `2026-08-25T00:00:${String(sequence).padStart(2, '0')}.000Z`,
        provenance: { origin: 'local-observed', trust: 'authoritative' },
      })
      events.push(normalized.events[0]!)
    }
    const thought = projectWorkbench(events).document.messages.find(message => message.role === 'reasoning')
    expect(thought?.content).toBe(text)
    expect(thought?.parts).toHaveLength(1)
    expect(thought?.parts[0]).toMatchObject({ kind: 'text', text })
  })

  it('live streamingThinking character updates remain one paragraph', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    const services = createPreviewWorkbenchServices()
    mountSolidWorkbench({ host, input: { sheetId: 'sheet-a', sessionId: 'preview-session', preview: true }, services })
    services.runtime.replaceDocument(createWorkbenchDocument('preview-session'), { ownerKey: 'owner-preview', generation: 1 })
    const text = '这是一个连续的思考过程，不应该每几个字符换段。'
    for (const char of [...text]) services.runtime.update({ streamingThinking: services.runtime.getSnapshot().streamingThinking + char, generating: true })
    const body = await waitFor(() => {
      const found = host.querySelector('.solid-workbench-chat .term-reasoning-body')
      expect(found).not.toBeNull()
      return found!
    })
    // body is collapsed by default; content still exists in DOM
    await waitFor(() => expect(body.textContent).toContain(text))
    expect(body.querySelectorAll('p')).toHaveLength(1)
    services.destroy()
    host.remove()
  })
})
