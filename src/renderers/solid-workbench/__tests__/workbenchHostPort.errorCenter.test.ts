// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createWorkbenchHostPort } from '../workbenchHostPort.ts'
import { createFakeWorkbenchCommandFacade } from '../../../domains/workbench/workbenchCommandFacade.ts'
import { createPreviewWorkbenchRuntime } from '../../../domains/workbench/workbenchRuntime.ts'
import { createStaticWorkbenchAppearanceStore } from '../../../domains/workbench/workbenchAppearanceStore.ts'
import { DEFAULTS } from '../../../domains/theme/themeDefaults.ts'
import { createSessionUiStore } from '../../../domains/workbench/sessionUiStore.ts'
import { clearErrors, getDiagnosticErrors, getErrorHistory, getErrors } from '../../../errorCenter.ts'

function runtime() {
  return createPreviewWorkbenchRuntime({
    sessionId: 'session-a', status: 'ready', messages: [], generating: false,
    generationStart: 0, tokenCount: 0, summary: null, tasks: [], availableModels: [], activeModel: '',
    availableModes: [], activeMode: '', canAttach: true, promptImage: false, error: null,
  })
}

afterEach(() => {
  clearErrors()
  vi.restoreAllMocks()
})

describe('Workbench HostPort error presentation', () => {
  it('把 command rejection 收口到 scoped ErrorCenter，并在成功事实后 resolve', async () => {
    vi.spyOn(window, 'dispatchEvent').mockImplementation(() => true)
    let reject = true
    const commands = createFakeWorkbenchCommandFacade({
      send: async () => reject
        ? { status: 'rejected', error: '命令被运行时拒绝' }
        : { status: 'sent', messageId: 'message-1' },
    })
    const host = createWorkbenchHostPort({
      runtime: runtime(), appearance: createStaticWorkbenchAppearanceStore(structuredClone(DEFAULTS)),
      sessionUi: createSessionUiStore(), commands,
      suiteId: 'builtin.solid', sheetId: 'sheet-a', sessionOwnerKey: 'owner-a', sessionId: 'session-a',
      capabilities: { prompt: true },
    })

    await host.commands.send('session-a', { text: '自检工具' })
    expect(getErrors()).toHaveLength(1)
    expect(getErrors()[0]).toMatchObject({
      action: '发送消息', source: 'workbench.command', code: 'command_rejected',
      scope: { kind: 'session', id: 'session-a' }, message: '命令被运行时拒绝',
    })

    reject = false
    await host.commands.send('session-a', { text: '重试' })
    expect(getErrors()).toHaveLength(0)
    expect(getErrorHistory().find(entry => entry.source === 'workbench.command')).toMatchObject({ state: 'resolved' })
  })

  it('异步 command 在切换会话后失败，不污染新会话或错误其作用域', async () => {
    vi.spyOn(window, 'dispatchEvent').mockImplementation(() => true)
    let settle: ((result: { status: 'rejected'; error: string }) => void) | undefined
    const commands = createFakeWorkbenchCommandFacade({
      send: async () => new Promise<{ status: 'rejected'; error: string }>(resolve => { settle = resolve }),
    })
    const binding = { suiteId: 'builtin.solid', sheetId: 'sheet-a', sessionOwnerKey: 'owner-a' as string | null, sessionId: 'session-a' as string | null }
    const host = createWorkbenchHostPort({
      runtime: runtime(), appearance: createStaticWorkbenchAppearanceStore(structuredClone(DEFAULTS)),
      sessionUi: createSessionUiStore(), commands,
      suiteId: binding.suiteId, sheetId: binding.sheetId, sessionOwnerKey: binding.sessionOwnerKey, sessionId: binding.sessionId,
      binding: () => binding,
      capabilities: { prompt: true },
    })

    const pending = host.commands.send('session-a', { text: '旧会话请求' })
    binding.sessionId = 'session-b'
    settle?.({ status: 'rejected', error: '旧会话失败' })
    await pending

    // The result belongs to the abandoned binding: keep it queryable as a
    // diagnostic, but never raise a badge for the newly selected session.
    expect(getErrors()).toHaveLength(0)
    expect(getDiagnosticErrors()).toHaveLength(1)
    expect(getDiagnosticErrors()[0]?.scope).toEqual({ kind: 'session', id: 'session-a' })
    expect(getDiagnosticErrors()[0]?.key).toContain('session-a')
  })
})
