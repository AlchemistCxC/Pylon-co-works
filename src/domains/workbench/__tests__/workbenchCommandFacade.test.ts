import { describe, expect, it, vi } from 'vitest'
import { createFakeWorkbenchCommandFacade } from '../workbenchCommandFacade.ts'

describe('createFakeWorkbenchCommandFacade', () => {
  it('记录全部 command 调用并提供无副作用默认结果', async () => {
    const facade = createFakeWorkbenchCommandFacade()

    await expect(facade.send('session-a', { text: 'hello' })).resolves.toEqual({ status: 'sent' })
    await expect(facade.cancel('session-a')).resolves.toEqual({ status: 'cancelled' })
    await expect(facade.attach('session-a')).resolves.toEqual([])
    await expect(facade.setModel('session-a', 'model-1')).resolves.toEqual({ ok: true })
    await expect(facade.setMode('session-a', 'mode-1')).resolves.toEqual({ ok: true })
    await expect(facade.createSession({ title: 'New' })).resolves.toEqual({ sessionId: 'preview-session' })
    await expect(facade.compact('session-a')).resolves.toEqual({ ok: true })
    await expect(facade.exportSession('session-a', { format: 'markdown' })).resolves.toEqual({ ok: true })
    await expect(facade.clearSession('session-a')).resolves.toEqual({ ok: true })

    expect(facade.calls.map(call => call.command)).toEqual([
      'send',
      'cancel',
      'attach',
      'setModel',
      'setMode',
      'createSession',
      'compact',
      'exportSession',
      'clearSession',
    ])
  })

  it('支持按 command 注入 fake 行为并保留错误结果', async () => {
    const send = vi.fn(async () => ({ status: 'queued' as const, messageId: 'queued-1' }))
    const facade = createFakeWorkbenchCommandFacade({ send })
    facade.setHandler('setMode', async () => ({ ok: false, error: 'mode unavailable' }))

    await expect(facade.send('session-a', {
      text: 'later',
      queueIfGenerating: true,
      attachments: [{ id: 'file-1', path: 'C:/tmp/a.txt' }],
    })).resolves.toEqual({ status: 'queued', messageId: 'queued-1' })
    await expect(facade.setMode('session-a', 'plan')).resolves.toEqual({
      ok: false,
      error: 'mode unavailable',
    })

    expect(send).toHaveBeenCalledWith('session-a', expect.objectContaining({ text: 'later' }))
    expect(facade.calls).toHaveLength(2)
  })

  it('reset 只清调用记录，不清注入 handler', async () => {
    const facade = createFakeWorkbenchCommandFacade()
    facade.setHandler('cancel', async () => ({ status: 'not-generating' }))

    await facade.cancel('session-a')
    facade.reset()

    expect(facade.calls).toEqual([])
    await expect(facade.cancel('session-a')).resolves.toEqual({ status: 'not-generating' })
    expect(facade.calls).toHaveLength(1)
  })
})
