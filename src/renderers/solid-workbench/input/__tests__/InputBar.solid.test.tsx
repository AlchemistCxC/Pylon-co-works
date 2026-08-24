// @vitest-environment jsdom
import { createSignal, onCleanup } from 'solid-js'
import { cleanup, fireEvent, render, screen, waitFor } from '@solidjs/testing-library'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULTS } from '../../../../domains/theme/themeDefaults.ts'
import { createPreviewWorkbenchServices } from '../../__fixtures__/previewWorkbenchServices.ts'
import { SolidWorkbenchContext, type SolidWorkbenchContextValue } from '../../SolidWorkbenchContext.solid.tsx'
import { SolidInputBar } from '../InputBar.solid.tsx'
import { getCommandRegistry } from '../../../../plugin-runtime/runtimeServices.ts'
import { createPluginIdentity } from '../../../../plugin-runtime/pluginIdentity.ts'
import { createWorkbenchEnvelope } from '../../../../domains/workbench/events/workbenchEventSchema.ts'
import { projectWorkbench } from '../../../../domains/workbench/workbenchProjector.ts'

const modelCommand = getCommandRegistry().register(
  createPluginIdentity('test.solid-input', 'solid-input-test'),
  { id: 'solid-test-model', name: 'model', description: '切换模型', inputHint: ' <name>', priority: -100 },
)

const servicesList: ReturnType<typeof createPreviewWorkbenchServices>[] = []

afterEach(() => {
  cleanup()
  for (const services of servicesList.splice(0)) services.destroy()
})
afterAll(() => { void modelCommand.dispose() })

function renderInput(sessionId = 'session-a', inputVariant: 'cli' | 'composer' = 'composer') {
  const services = createPreviewWorkbenchServices()
  services.runtime.update({ sessionId, generating: false, streamingText: '', streamingThinking: '' })
  const theme = structuredClone(DEFAULTS)
  theme.inputVariant = inputVariant
  theme.inputMode = inputVariant === 'cli' ? 'cli' : 'default'
  services.appearance.setTheme(theme)
  servicesList.push(services)
  const [runtimeSnapshot, setRuntimeSnapshot] = createSignal(services.runtime.getSnapshot())
  const [appearanceSnapshot, setAppearanceSnapshot] = createSignal(services.appearance.getSnapshot())
  const [activeSessionId, setActiveSessionId] = createSignal(sessionId)
  const input = () => ({ sheetId: 'sheet-a', sessionId: activeSessionId(), preview: true })
  const context: SolidWorkbenchContextValue = {
    input,
    runtime: services.runtime,
    runtimeSnapshot,
    appearance: services.appearance,
    appearanceSnapshot,
    sessionUi: services.sessionUi,
    commands: services.commands,
    paused: () => false,
  }
  render(() => {
    const unsubscribeRuntime = services.runtime.subscribe(() => setRuntimeSnapshot(services.runtime.getSnapshot()))
    const unsubscribeAppearance = services.appearance.subscribe(() => setAppearanceSnapshot(services.appearance.getSnapshot()))
    onCleanup(() => {
      unsubscribeRuntime()
      unsubscribeAppearance()
    })
    return (
      <SolidWorkbenchContext.Provider value={context}>
        <SolidInputBar />
      </SolidWorkbenchContext.Provider>
    )
  })
  return {
    services,
    textarea: screen.getByRole('textbox') as HTMLTextAreaElement,
    switchSession(nextSessionId: string) {
      setActiveSessionId(nextSessionId)
      services.runtime.update({ sessionId: nextSessionId })
    },
  }
}

describe('SolidInputBar', () => {
  it('Enter 发送，Shift+Enter 与 IME composition 不发送', async () => {
    const { services, textarea } = renderInput()
    fireEvent.input(textarea, { target: { value: '正常消息' } })
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true })
    expect(services.commands.calls).toHaveLength(0)

    fireEvent.compositionStart(textarea)
    fireEvent.keyDown(textarea, { key: 'Enter' })
    expect(services.commands.calls).toHaveLength(0)
    fireEvent.compositionEnd(textarea)
    fireEvent.keyDown(textarea, { key: 'Enter' })

    await waitFor(() => expect(services.commands.calls[0]?.command).toBe('send'))
    expect(services.commands.calls[0]?.args).toEqual(['session-a', { text: '正常消息', attachments: [] }])
    expect(textarea.value).toBe('')
  })

  it('发送未完成时切换会话，不会清空新会话草稿或串写历史', async () => {
    let resolveSend: ((value: { status: 'sent'; messageId: string }) => void) | undefined
    const { services, textarea, switchSession } = renderInput()
    services.commands.setHandler('send', vi.fn(() => new Promise<{ status: 'sent'; messageId: string }>(resolve => { resolveSend = resolve })))

    fireEvent.input(textarea, { target: { value: 'A 会话消息' } })
    fireEvent.keyDown(textarea, { key: 'Enter' })
    await waitFor(() => expect(services.commands.calls[0]?.command).toBe('send'))

    switchSession('session-b')
    await waitFor(() => expect(textarea.value).toBe(''))
    fireEvent.input(textarea, { target: { value: 'B 会话草稿' } })
    resolveSend?.({ status: 'sent', messageId: 'message-a' })

    await waitFor(() => expect(services.sessionUi.get('session-a', 'input-history', [])).toEqual(['A 会话消息']))
    expect(textarea.value).toBe('B 会话草稿')
    expect(services.sessionUi.get('session-b', 'draft', '')).toBe('B 会话草稿')
    expect(services.sessionUi.get('session-b', 'input-history', [])).toEqual([])
  })

  it('发送等待期间输入的下一条草稿不会被旧请求成功回调清空', async () => {
    let resolveSend: ((value: { status: 'sent'; messageId: string }) => void) | undefined
    const { services, textarea } = renderInput()
    services.commands.setHandler('send', vi.fn(() => new Promise<{ status: 'sent'; messageId: string }>(resolve => { resolveSend = resolve })))

    fireEvent.input(textarea, { target: { value: '第一条' } })
    fireEvent.keyDown(textarea, { key: 'Enter' })
    await waitFor(() => expect(services.commands.calls[0]?.command).toBe('send'))
    fireEvent.input(textarea, { target: { value: '发送期间写下的下一条' } })
    resolveSend?.({ status: 'sent', messageId: 'message-a' })

    await waitFor(() => expect(services.sessionUi.get('session-a', 'input-history', [])).toEqual(['第一条']))
    expect(textarea.value).toBe('发送期间写下的下一条')
  })

  it('发送失败提示只显示在发起会话', async () => {
    let resolveSend: ((value: { status: 'rejected'; error: string }) => void) | undefined
    const sendPromise = new Promise<{ status: 'rejected'; error: string }>(resolve => { resolveSend = resolve })
    const { services, textarea, switchSession } = renderInput()
    services.commands.setHandler('send', vi.fn(() => sendPromise))

    fireEvent.input(textarea, { target: { value: 'A 会话消息' } })
    fireEvent.keyDown(textarea, { key: 'Enter' })
    await waitFor(() => expect(services.commands.calls[0]?.command).toBe('send'))
    switchSession('session-b')
    resolveSend?.({ status: 'rejected', error: 'A send failed' })
    await sendPromise
    await Promise.resolve()

    expect(screen.queryByRole('alert')).toBeNull()
    switchSession('session-a')
    expect(await screen.findByRole('alert')).toHaveTextContent('A send failed')
  })

  it('生成期间 Enter 入队，停止后可手动发送并删除队列项', async () => {
    const { services, textarea } = renderInput()
    services.runtime.update({ generating: true })
    fireEvent.input(textarea, { target: { value: '稍后发送' } })
    fireEvent.keyDown(textarea, { key: 'Enter' })

    expect(await screen.findByText('稍后发送')).toBeTruthy()
    expect(services.commands.calls).toHaveLength(0)

    services.runtime.update({ generating: false })
    await waitFor(() => expect(screen.getByRole('button', { name: '发送待发送消息' })).not.toBeDisabled())
    fireEvent.click(screen.getByRole('button', { name: '发送待发送消息' }))
    await waitFor(() => expect(services.commands.calls[0]?.command).toBe('send'))
    await waitFor(() => expect(screen.queryByText('稍后发送')).toBeNull())
  })

  it('生成期间排队的消息保留当时选择的附件', async () => {
    const { services, textarea } = renderInput()
    services.commands.setHandler('attach', vi.fn(async () => [
      { id: 'a', path: 'C:/a.txt', name: 'a.txt' },
    ]))
    fireEvent.click(screen.getByRole('button', { name: '添加附件' }))
    expect(await screen.findByRole('button', { name: '移除附件 a.txt' })).toBeTruthy()

    services.commands.reset()
    services.runtime.update({ generating: true })
    fireEvent.input(textarea, { target: { value: '稍后读取附件' } })
    fireEvent.keyDown(textarea, { key: 'Enter' })
    services.runtime.update({ generating: false })
    fireEvent.click(await screen.findByRole('button', { name: '发送待发送消息' }))

    await waitFor(() => expect(services.commands.calls).toContainEqual({
      command: 'send',
      args: ['session-a', {
        text: '稍后读取附件',
        attachments: [{ id: 'a', path: 'C:/a.txt', name: 'a.txt' }],
      }],
    }))
  })

  it('Slash command 走 facade，不作为普通 send', async () => {
    const { services, textarea } = renderInput()
    fireEvent.input(textarea, { target: { value: '/model deepseek-chat' } })
    expect(screen.getByRole('listbox', { name: '命令建议' })).toBeTruthy()
    fireEvent.keyDown(textarea, { key: 'Enter' })

    await waitFor(() => expect(services.commands.calls[0]?.command).toBe('setModel'))
    expect(services.commands.calls[0]?.args).toEqual(['session-a', 'deepseek-chat'])
    expect(services.commands.calls.some(call => call.command === 'send')).toBe(false)
  })

  it('实时消费 canonical session commands，且同名插件命令不覆盖会话权威', async () => {
    const { services, textarea } = renderInput()
    const document = projectWorkbench([createWorkbenchEnvelope({
      sessionId: 'session-a', recordedAt: '2026-08-24T00:00:00.000Z', sequence: 1,
      source: { provider: 'peri', sourceId: 'commands-1' },
      provenance: { origin: 'local-observed', trust: 'authoritative' },
      event: { type: 'session.commands-updated', commands: [
        { id: 'model', name: '/model', description: '会话模型命令', inputHint: ' <session-model>', availability: true },
        { id: 'review', name: '/review', description: '审查当前改动', inputHint: ' <scope>', availability: true },
      ] },
    })]).document
    services.runtime.replaceDocument(document, { ownerKey: 'owner-a', generation: 1 })

    fireEvent.input(textarea, { target: { value: '/model' } })
    expect(await screen.findByText('会话模型命令')).toBeTruthy()
    expect(screen.queryByText('切换模型')).toBeNull()

    fireEvent.input(textarea, { target: { value: '/review' } })
    expect(await screen.findByText('审查当前改动')).toBeTruthy()
    expect(screen.getByText('/review <scope>')).toBeTruthy()
    fireEvent.input(textarea, { target: { value: '/review src' } })
    fireEvent.keyDown(textarea, { key: 'Enter' })
    await waitFor(() => expect(services.commands.calls).toContainEqual({
      command: 'send', args: ['session-a', { text: '/review src', attachments: [] }],
    }))

    services.runtime.replaceDocument(projectWorkbench([createWorkbenchEnvelope({
      sessionId: 'session-a', recordedAt: '2026-08-24T00:00:01.000Z', sequence: 2,
      source: { provider: 'peri', sourceId: 'commands-2' },
      provenance: { origin: 'local-observed', trust: 'authoritative' },
      event: { type: 'session.commands-updated', commands: [
        { id: 'audit', name: '/audit', description: '全量审计', availability: true },
      ] },
    })]).document, { ownerKey: 'owner-a', generation: 2 })
    fireEvent.input(textarea, { target: { value: '/audit' } })
    expect(await screen.findByText('全量审计')).toBeTruthy()
  })

  it('附件通过 facade 注入，去重并可移除', async () => {
    const { services } = renderInput()
    services.commands.setHandler('attach', vi.fn(async () => [
      { id: 'a', path: 'C:/a.txt', name: 'a.txt' },
      { id: 'a-copy', path: 'C:/a.txt', name: 'a.txt' },
    ]))

    fireEvent.click(screen.getByRole('button', { name: '添加附件' }))
    expect(await screen.findByRole('button', { name: '移除附件 a.txt' })).toBeTruthy()
    expect(screen.getAllByText(/a\.txt/)).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: '移除附件 a.txt' }))
    expect(screen.queryByRole('button', { name: '移除附件 a.txt' })).toBeNull()
  })

  it('附件选择未完成时切换会话，结果只归属发起会话', async () => {
    let resolveAttach: ((value: Array<{ id: string; path: string; name: string }>) => void) | undefined
    const attachPromise = new Promise<Array<{ id: string; path: string; name: string }>>(resolve => { resolveAttach = resolve })
    const { services, switchSession } = renderInput()
    services.commands.setHandler('attach', vi.fn(() => attachPromise))

    fireEvent.click(screen.getByRole('button', { name: '添加附件' }))
    await waitFor(() => expect(services.commands.calls[0]?.command).toBe('attach'))
    switchSession('session-b')
    resolveAttach?.([{ id: 'a', path: 'C:/a.txt', name: 'a.txt' }])
    await attachPromise
    await Promise.resolve()

    expect(screen.queryByRole('button', { name: '移除附件 a.txt' })).toBeNull()
    switchSession('session-a')
    expect(await screen.findByRole('button', { name: '移除附件 a.txt' })).toBeTruthy()
  })

  it('Esc/Ctrl+C 在生成时取消，失败结果展示可见错误', async () => {
    const { services, textarea } = renderInput()
    services.runtime.update({ generating: true })
    services.commands.setHandler('cancel', vi.fn(async () => ({ status: 'rejected' as const, error: 'cancel denied' })))

    fireEvent.keyDown(textarea, { key: 'Escape' })
    expect(await screen.findByRole('alert')).toHaveTextContent('cancel denied')
    expect(services.commands.calls[0]?.command).toBe('cancel')

    services.commands.reset()
    fireEvent.keyDown(textarea, { key: 'c', ctrlKey: true })
    await waitFor(() => expect(services.commands.calls[0]?.command).toBe('cancel'))
  })

  it('历史记录按 SessionUiStore 保存并可用方向键恢复', async () => {
    const { services, textarea } = renderInput()
    fireEvent.input(textarea, { target: { value: '第一条' } })
    fireEvent.keyDown(textarea, { key: 'Enter' })
    await waitFor(() => expect(textarea.value).toBe(''))
    fireEvent.input(textarea, { target: { value: '当前草稿' } })
    fireEvent.keyDown(textarea, { key: 'ArrowUp' })

    expect(textarea.value).toBe('第一条')
    expect(services.sessionUi.get('session-a', 'input-history', [])).toEqual(['第一条'])
    fireEvent.keyDown(textarea, { key: 'ArrowDown' })
    expect(textarea.value).toBe('当前草稿')
  })
})
