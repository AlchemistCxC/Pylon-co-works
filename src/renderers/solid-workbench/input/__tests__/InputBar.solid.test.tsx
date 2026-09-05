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
import type { InputPredictionProvider } from '../inputPredictionProvider.ts'

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

function renderInput(sessionId = 'session-a', inputVariant: 'cli' | 'composer' = 'composer', predictionProvider?: InputPredictionProvider) {
  const services = createPreviewWorkbenchServices()
  services.runtime.update({ sessionId, generating: false })
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
        <SolidInputBar predictionProvider={predictionProvider} />
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

  it('提交开始时立即清空输入框，发送失败且期间没有新输入时恢复原草稿', async () => {
    let resolveSend: ((value: { status: 'rejected'; error: string }) => void) | undefined
    const { services, textarea } = renderInput()
    services.commands.setHandler('send', vi.fn(() => new Promise<{ status: 'rejected'; error: string }>(resolve => { resolveSend = resolve })))

    fireEvent.input(textarea, { target: { value: '立即离开输入框' } })
    fireEvent.keyDown(textarea, { key: 'Enter' })

    await waitFor(() => expect(services.commands.calls[0]?.command).toBe('send'))
    expect(textarea.value).toBe('')

    resolveSend?.({ status: 'rejected', error: '网络暂时不可用' })
    await waitFor(() => expect(textarea.value).toBe('立即离开输入框'))
    expect(screen.getByRole('alert')).toHaveTextContent('网络暂时不可用')
  })

  it('发送失败时不以旧消息覆盖等待期间输入的新草稿', async () => {
    let resolveSend: ((value: { status: 'rejected'; error: string }) => void) | undefined
    const { services, textarea } = renderInput()
    services.commands.setHandler('send', vi.fn(() => new Promise<{ status: 'rejected'; error: string }>(resolve => { resolveSend = resolve })))

    fireEvent.input(textarea, { target: { value: '失败的消息' } })
    fireEvent.keyDown(textarea, { key: 'Enter' })
    await waitFor(() => expect(textarea.value).toBe(''))
    fireEvent.input(textarea, { target: { value: '发送期间的新草稿' } })
    resolveSend?.({ status: 'rejected', error: '发送失败' })

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('发送失败'))
    expect(textarea.value).toBe('发送期间的新草稿')
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

  it('生成结束后自动发送队首，并等待下一轮结束后再发下一条', async () => {
    const { services, textarea } = renderInput()
    services.runtime.update({ generating: true })
    fireEvent.input(textarea, { target: { value: '第一条待发' } })
    fireEvent.keyDown(textarea, { key: 'Enter' })
    fireEvent.input(textarea, { target: { value: '第二条待发' } })
    fireEvent.keyDown(textarea, { key: 'Enter' })

    expect(await screen.findByText('第一条待发')).toBeTruthy()
    expect(screen.getByText('第二条待发')).toBeTruthy()
    expect(services.commands.calls).toHaveLength(0)

    services.runtime.update({ generating: false })
    await waitFor(() => expect(services.commands.calls).toHaveLength(1))
    expect(services.commands.calls[0]).toEqual({
      command: 'send', args: ['session-a', { text: '第一条待发', attachments: [] }],
    })
    expect(screen.queryByText('第一条待发')).toBeNull()
    expect(screen.getByText('第二条待发')).toBeTruthy()

    services.runtime.update({ generating: true })
    services.runtime.update({ generating: false })
    await waitFor(() => expect(services.commands.calls).toHaveLength(2))
    expect(services.commands.calls[1]).toEqual({
      command: 'send', args: ['session-a', { text: '第二条待发', attachments: [] }],
    })
    await waitFor(() => expect(screen.queryByText('第二条待发')).toBeNull())
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

  it('待发消息发送未完成时禁用队列按钮，避免重复提交', async () => {
    let resolveSend: ((value: { status: 'sent'; messageId: string }) => void) | undefined
    const { services, textarea } = renderInput()
    services.commands.setHandler('send', vi.fn(() => new Promise<{ status: 'sent'; messageId: string }>(resolve => { resolveSend = resolve })))
    services.runtime.update({ generating: true })
    fireEvent.input(textarea, { target: { value: '只能发送一次' } })
    fireEvent.keyDown(textarea, { key: 'Enter' })
    services.runtime.update({ generating: false })

    await waitFor(() => expect(services.commands.calls).toHaveLength(1))
    const sendQueuedButton = screen.getByRole('button', { name: '发送待发送消息' })
    expect(sendQueuedButton).toBeDisabled()
    fireEvent.click(sendQueuedButton)
    expect(services.commands.calls).toHaveLength(1)

    resolveSend?.({ status: 'sent', messageId: 'queued-message' })
    await waitFor(() => expect(screen.queryByText('只能发送一次')).toBeNull())
  })

  it('待发消息进入编辑态后聚焦编辑框，并明确提供完成操作', async () => {
    const { services, textarea } = renderInput()
    services.runtime.update({ generating: true })
    fireEvent.input(textarea, { target: { value: '需要修改的消息' } })
    fireEvent.keyDown(textarea, { key: 'Enter' })

    fireEvent.click(await screen.findByRole('button', { name: '编辑待发送消息' }))

    await waitFor(() => expect(screen.getByRole('textbox', { name: '编辑待发送消息' })).toHaveFocus())
    expect(screen.getByRole('button', { name: '完成编辑待发送消息' })).toBeTruthy()
  })

  it('待发消息编辑时按 Esc 保留修改并把焦点返回编辑按钮', async () => {
    const { services, textarea } = renderInput()
    services.runtime.update({ generating: true })
    fireEvent.input(textarea, { target: { value: '原始待发消息' } })
    fireEvent.keyDown(textarea, { key: 'Enter' })
    fireEvent.click(await screen.findByRole('button', { name: '编辑待发送消息' }))
    const editor = screen.getByRole('textbox', { name: '编辑待发送消息' })
    fireEvent.input(editor, { target: { value: '修改后的待发消息' } })
    expect(screen.getByRole('textbox', { name: '编辑待发送消息' })).toBe(editor)

    fireEvent.keyDown(screen.getByRole('textbox', { name: '编辑待发送消息' }), { key: 'Escape' })

    expect(await screen.findByText('修改后的待发消息')).toBeTruthy()
    const edit = screen.getByRole('button', { name: '编辑待发送消息' })
    await waitFor(() => expect(edit).toHaveFocus())
  })

  it('队首编辑期间暂停自动续发，完成后发送最新文本', async () => {
    const { services, textarea } = renderInput()
    services.runtime.update({ generating: true })
    fireEvent.input(textarea, { target: { value: '尚未修改' } })
    fireEvent.keyDown(textarea, { key: 'Enter' })
    fireEvent.click(await screen.findByRole('button', { name: '编辑待发送消息' }))
    fireEvent.input(screen.getByRole('textbox', { name: '编辑待发送消息' }), { target: { value: '最终待发内容' } })

    services.runtime.update({ generating: false })
    await Promise.resolve()
    expect(services.commands.calls).toHaveLength(0)
    expect(screen.getByRole('button', { name: '发送待发送消息' })).toBeDisabled()

    fireEvent.click(screen.getByRole('button', { name: '完成编辑待发送消息' }))
    await waitFor(() => expect(services.commands.calls).toContainEqual({
      command: 'send', args: ['session-a', { text: '最终待发内容', attachments: [] }],
    }))
  })

  it('生成在后台结束后，返回原会话会继续发送其队列', async () => {
    const { services, textarea, switchSession } = renderInput()
    services.runtime.update({ generating: true })
    fireEvent.input(textarea, { target: { value: 'A 后台待发' } })
    fireEvent.keyDown(textarea, { key: 'Enter' })

    switchSession('session-b')
    services.runtime.update({ generating: false })
    expect(services.commands.calls).toHaveLength(0)
    switchSession('session-a')

    await waitFor(() => expect(services.commands.calls).toContainEqual({
      command: 'send', args: ['session-a', { text: 'A 后台待发', attachments: [] }],
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

  it('Tab 确认当前命令建议并把参数提示带入草稿', () => {
    const { textarea } = renderInput()
    fireEvent.input(textarea, { target: { value: '/mod' } })

    fireEvent.keyDown(textarea, { key: 'Tab' })

    expect(textarea.value).toBe('/model <name> ')
    expect(screen.getByRole('listbox', { name: '命令建议' })).toBeTruthy()
  })

  it('Enter 补全尚未输入完整的命令名，不误发为普通消息', () => {
    const { services, textarea } = renderInput()
    fireEvent.input(textarea, { target: { value: '/mo' } })

    fireEvent.keyDown(textarea, { key: 'Enter' })

    expect(textarea.value).toBe('/model <name> ')
    expect(services.commands.calls).toHaveLength(0)
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

  it('多行草稿中非首末行的方向键保留给原生光标移动', async () => {
    const { services, textarea } = renderInput()
    fireEvent.input(textarea, { target: { value: '历史消息' } })
    fireEvent.keyDown(textarea, { key: 'Enter' })
    await waitFor(() => expect(textarea.value).toBe(''))
    fireEvent.input(textarea, { target: { value: '第一行\n第二行\n第三行' } })
    textarea.setSelectionRange(7, 7)

    expect(fireEvent.keyDown(textarea, { key: 'ArrowUp' })).toBe(true)
    expect(textarea.value).toBe('第一行\n第二行\n第三行')
    expect(fireEvent.keyDown(textarea, { key: 'ArrowDown' })).toBe(true)
    expect(textarea.value).toBe('第一行\n第二行\n第三行')
    expect(services.sessionUi.get('session-a', 'input-history-index', -1)).toBe(-1)
  })

  it('没有历史记录时不拦截方向键', () => {
    const { textarea } = renderInput()
    fireEvent.input(textarea, { target: { value: '当前草稿' } })

    expect(fireEvent.keyDown(textarea, { key: 'ArrowUp' })).toBe(true)
    expect(fireEvent.keyDown(textarea, { key: 'ArrowDown' })).toBe(true)
    expect(textarea.value).toBe('当前草稿')
  })

  it('历史消息提供 ghost text，Tab 接受但不新增 input-history', async () => {
    const { services, textarea } = renderInput()
    fireEvent.input(textarea, { target: { value: '继续做' } })
    fireEvent.keyDown(textarea, { key: 'Enter' })
    await waitFor(() => expect(textarea.value).toBe(''))
    fireEvent.input(textarea, { target: { value: '继续' } })

    expect(await screen.findByText('做')).toBeTruthy()
    fireEvent.keyDown(textarea, { key: 'Tab' })
    expect(textarea.value).toBe('继续做')
    expect(services.sessionUi.get('session-a', 'input-history', [])).toEqual(['继续做'])
  })

  it('ghost text 可用右箭头接受，Esc 忽略且编辑后重新计算', async () => {
    const { textarea } = renderInput()
    fireEvent.input(textarea, { target: { value: '继续做' } })
    fireEvent.keyDown(textarea, { key: 'Enter' })
    await waitFor(() => expect(textarea.value).toBe(''))
    fireEvent.input(textarea, { target: { value: '继续' } })
    expect(await screen.findByText('做')).toBeTruthy()
    fireEvent.keyDown(textarea, { key: 'Escape' })
    expect(screen.queryByText('做')).toBeNull()
    fireEvent.input(textarea, { target: { value: '继续' } })
    expect(await screen.findByText('做')).toBeTruthy()
    fireEvent.keyDown(textarea, { key: 'ArrowRight' })
    expect(textarea.value).toBe('继续做')
  })

  it('可选 provider 在空草稿时低频请求并显示模型 ghost text', async () => {
    const provider: InputPredictionProvider = { predict: vi.fn(async () => '模型建议继续') }
    const { textarea } = renderInput('session-a', 'composer', provider)
    expect(await screen.findByText('模型建议继续', {}, { timeout: 1_500 })).toBeTruthy()
    expect(provider.predict).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(textarea, { key: 'Tab' })
    expect(textarea.value).toBe('模型建议继续')
  })
})
