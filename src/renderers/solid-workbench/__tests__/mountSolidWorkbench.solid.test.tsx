// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from '@solidjs/testing-library'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mountSolidWorkbench, mountSolidWorkbenchFromHostPort } from '../mountSolidWorkbench.solid.tsx'
import { createPreviewWorkbenchServices } from '../__fixtures__/previewWorkbenchServices.ts'
import { createWorkbenchEnvelope, type WorkbenchEventEnvelope } from '../../../domains/workbench/events/workbenchEventSchema.ts'
import { projectWorkbench, reduceWorkbenchEvent } from '../../../domains/workbench/workbenchProjector.ts'
import { createWorkbenchHostPort } from '../workbenchHostPort.ts'
import type { WorkbenchCapabilitySnapshot } from '../workbenchHostPort.ts'
import { RendererSuiteHost } from '../../../host/renderer-suite/rendererSuiteHost.ts'
import type { RendererActivationSnapshot, RendererSlotContribution, RendererSuiteContribution } from '../../../plugin-runtime/renderers/rendererSuiteTypes.ts'
import type { RegistryEntry } from '../../../plugin-runtime/registry/types.ts'
import { BUILTIN_TEXT_RENDER_KINDS } from '../../../domains/rendererContent/textRenderKindCatalog.ts'
import { BUILTIN_TOOL_RENDER_KINDS } from '../../../domains/rendererContent/toolRenderKindCatalog.ts'
import { BUILTIN_EXECUTION_RENDER_KINDS } from '../../../domains/rendererContent/executionRenderKindCatalog.ts'
import { BUILTIN_INTERACTION_RENDER_KINDS } from '../../../domains/rendererContent/interactionRenderKindCatalog.ts'
import { createBuiltinSolidContentSlot } from '../builtinSolidRendererSuite.ts'
import { DEFAULTS } from '../../../domains/theme/themeDefaults.ts'

const hosts: HTMLElement[] = []
const servicesList: ReturnType<typeof createPreviewWorkbenchServices>[] = []

afterEach(() => {
  cleanup()
  for (const services of servicesList.splice(0)) services.destroy()
  for (const host of hosts.splice(0)) host.remove()
})

function mountPreview(capabilities?: WorkbenchCapabilitySnapshot) {
  const host = document.createElement('div')
  document.body.append(host)
  hosts.push(host)
  const services = createPreviewWorkbenchServices()
  servicesList.push(services)
  const hostPort = capabilities ? createWorkbenchHostPort({
    ...services,
    suiteId: 'builtin.solid',
    sheetId: 'sheet-a',
    sessionOwnerKey: 'owner-preview',
    sessionId: 'preview-session',
    capabilities,
  }) : undefined
  const lifecycle = mountSolidWorkbench({
    host,
    input: {
      sheetId: 'sheet-a',
      sessionId: 'preview-session',
      preview: true,
      rightInset: 24,
      reducedMotion: true,
    },
    services,
    hostPort,
  })
  return { host, services, lifecycle }
}

describe('mountSolidWorkbench', () => {
  it('消费会话搜索状态，高亮并定位当前匹配消息', async () => {
    const scrollIntoView = vi.fn()
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    })
    const { host, services } = mountPreview()

    services.sessionUi.set('preview-session', 'search-query', 'runtime 保持')
    services.sessionUi.set('preview-session', 'search-index', -7)

    await waitFor(() => expect(
      host.querySelector('[data-message-id="fixture-assistant-markdown"] .term-row-search-active'),
    ).not.toBeNull())
    expect(services.sessionUi.get('preview-session', 'search-index', -1)).toBe(0)
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center' })
  })

  it('用户离开底部后不抢滚动，并可一键恢复自动跟随', async () => {
    const scrollIntoView = vi.fn()
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    })
    const { host, services } = mountPreview()
    const viewport = host.querySelector('.solid-workbench-chat') as HTMLDivElement
    Object.defineProperties(viewport, {
      scrollTop: { value: 100, writable: true, configurable: true },
      scrollHeight: { value: 1_000, configurable: true },
      clientHeight: { value: 300, configurable: true },
    })

    fireEvent.scroll(viewport)
    expect(await screen.findByRole('button', { name: '回到底部' })).toBeTruthy()
    scrollIntoView.mockClear()

    services.runtime.update({ streamingText: '用户上滚后的新输出' })
    await Promise.resolve()
    expect(scrollIntoView).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: '回到底部' }))
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'auto', block: 'end' })
    expect(screen.queryByRole('button', { name: '回到底部' })).toBeNull()

    scrollIntoView.mockClear()
    services.runtime.update({ streamingText: '恢复跟随后继续输出' })
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'auto', block: 'end' }))
  })

  it('右栏与 Solid 对 canonical semantic parts 使用同一搜索文本口径', async () => {
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn(),
    })
    const { host, services } = mountPreview()
    const current = services.runtime.getSnapshot().document!
    const target = current.messages.find(message => message.id === 'fixture-assistant-markdown')!
    services.runtime.replaceDocument({
      ...current,
      messages: [{ ...target, content: '', parts: [{ kind: 'text', text: 'canonical semantic needle' }] }],
    }, { ownerKey: 'owner-preview', generation: 1 })

    services.sessionUi.set('preview-session', 'search-query', 'semantic needle')

    await waitFor(() => expect(
      host.querySelector('[data-message-id="fixture-assistant-markdown"] .term-row-search-active'),
    ).not.toBeNull())
  })

  it('挂载完整 fixture shell，复用 Message/Tool/Task/Generation renderer', async () => {
    const { host } = mountPreview()

    expect(screen.getByLabelText('Solid Agent Workbench')).toBeTruthy()
    expect(host.querySelector('[data-renderer="solid"]')?.getAttribute('data-preview')).toBe('true')
    expect(await screen.findByRole('heading', { name: '迁移结果' }, { timeout: 5_000 })).toBeTruthy()
    expect(screen.getByText('Read')).toBeTruthy()
    expect(host.querySelector('.task-tree')).toBeTruthy()
    expect(host.querySelector('.term-spinner')).toBeTruthy()
    expect(host.querySelector('.control-center')?.getAttribute('data-control-center')).toBe('production')
    expect(host.querySelector('.pet-companion')?.getAttribute('data-fixture')).toBe('pending')
    await waitFor(() => expect(host.querySelectorAll('.plain-message-list__row').length).toBeGreaterThan(0))
  })

  it('update 不重挂 root，并切换 replay/Session 输入', async () => {
    const { host, lifecycle } = mountPreview()
    const root = host.firstElementChild

    lifecycle.update({
      sheetId: 'sheet-a',
      sessionId: 'preview-session',
      preview: true,
      replayReadonly: true,
      rightInset: 80,
    })

    await waitFor(() => expect(screen.getByText('历史回放 · 只读')).toBeTruthy())
    expect(host.firstElementChild).toBe(root)
    expect(host.querySelector('.control-center')).toBeNull()
    expect(host.firstElementChild?.getAttribute('style')).toContain('--right-panel-inset: 80px')

    lifecycle.update({
      sheetId: 'sheet-a', sessionId: null, preview: true, workspaceMode: 'work',
    })
    const emptyState = await screen.findByRole('region', { name: 'Agent 工作台空态' })
    expect(emptyState).toHaveTextContent('准备开始')
    expect(screen.getByRole('combobox', { name: '新会话工作区' })).toBeTruthy()
    expect(screen.getByRole('textbox', { name: '首条请求' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '开始新会话' })).toBeDisabled()
    expect(host.querySelector('.control-center')).toBeNull()
    expect(host.firstElementChild).toBe(root)
  })

  it('pause 冻结 runtime/appearance 推送，resume 一次收敛最新快照', async () => {
    const { host, services, lifecycle } = mountPreview()
    lifecycle.pause()
    services.runtime.update({ streamingText: '暂停期间的新文本', tokenCount: 99 })
    services.appearance.dispatch({ type: 'set-cc-edit-mode', enabled: true })

    expect(host.querySelector('[data-paused="true"]')).toBeTruthy()
    expect(screen.queryByText('暂停期间的新文本')).toBeNull()

    lifecycle.resume()
    await waitFor(() => expect(screen.getByText('暂停期间的新文本')).toBeTruthy())
    expect(host.querySelector('[data-paused="false"]')).toBeTruthy()
  })

  it('preview 不暴露真实停止按钮，destroy 幂等并清空 DOM', () => {
    const { host, lifecycle } = mountPreview()
    expect(screen.queryByTitle('停止生成 (Esc / Ctrl+C)')).toBeNull()

    lifecycle.destroy()
    lifecycle.destroy()
    expect(host.childElementCount).toBe(0)
  })

  it('生产中控消费提交模式、隐藏项与布局槽位权威', async () => {
    const { host, services, lifecycle } = mountPreview()
    const theme = structuredClone(DEFAULTS)
    theme.inputMode = 'default'
    theme.inputVariant = 'composer'
    theme.inputSubmitButtonMode = 'inline'
    services.appearance.setTheme(theme)

    await waitFor(() => expect(screen.getByRole('button', { name: '停止生成' })).toBeTruthy())
    expect(host.querySelector('.cc-send-icon, .cc-send-square, .cc-send-minimal')).toBeNull()
    expect(host.querySelector('.cc-attach-icon, .cc-attach-square, .cc-attach-minimal')).toBeNull()
    expect(screen.getAllByRole('button', { name: '停止生成' })).toHaveLength(1)

    theme.inputSubmitButtonMode = 'external'
    theme.ccHidden = ['attach']
    theme.ccLayout.placements.send = { slot: 'actions', order: 0, offsetX: 0, offsetY: 0 }
    theme.ccLayout.placements.model = { slot: 'actions', order: 1, offsetX: 0, offsetY: 0 }
    services.appearance.setTheme(theme)

    await waitFor(() => expect(host.querySelector('.cc-actions [data-widget-id="send"]')).toBeTruthy())
    expect(host.querySelector('[data-widget-id="attach"]')).toBeNull()
    expect(Array.from(host.querySelectorAll('.cc-actions [data-widget-id]')).map(node => node.getAttribute('data-widget-id')))
      .toEqual(['send', 'model'])

    lifecycle.update({
      sheetId: 'sheet-a', sessionId: 'preview-session', preview: true,
      presentationProfileId: 'builtin.presentation.terminal-classic',
    })
    await waitFor(() => expect(host.querySelector('[data-widget-id="session"]')).toBeNull())
    expect(host.querySelector('[data-widget-id="workspace"]')).toBeNull()
    expect(host.querySelector('[data-widget-id="activity"]')).toBeNull()
  })

  it('外置按钮模式下单独隐藏发送或附件不会误吞掉输入栏另一按钮', async () => {
    const { host, services } = mountPreview()
    const theme = structuredClone(DEFAULTS)
    theme.inputMode = 'default'
    theme.inputVariant = 'composer'
    theme.inputSubmitButtonMode = 'external'
    theme.ccHidden = ['send']
    services.appearance.setTheme(theme)

    await waitFor(() => expect(host.querySelector('[data-widget-id="attach"]')).toBeTruthy())
    expect(host.querySelector('[data-widget-id="send"]')).toBeNull()
    expect(host.querySelector('.input-btn.send, .input-btn.stop')).toHaveAttribute('aria-label', '停止生成')
    expect(host.querySelector('.input-btn.attach')).toBeNull()

    theme.ccHidden = ['attach']
    services.appearance.setTheme(theme)
    await waitFor(() => expect(host.querySelector('[data-widget-id="send"]')).toBeTruthy())
    expect(host.querySelector('[data-widget-id="attach"]')).toBeNull()
    expect(host.querySelector('.input-btn.send, .input-btn.stop')).toBeNull()
    expect(host.querySelector('.input-btn.attach')).toHaveAttribute('aria-label', '添加附件')
  })

  it('中控编辑模式可选择并拖动 widget，布局写回 appearance 权威', async () => {
    const { host, services } = mountPreview()
    services.appearance.dispatch({ type: 'set-cc-edit-mode', enabled: true })

    const model = await waitFor(() => {
      const value = host.querySelector<HTMLElement>('[data-widget-id="model"]')
      expect(value).not.toBeNull()
      return value!
    })
    fireEvent.pointerDown(model, { clientX: 10, clientY: 20, pointerId: 1 })

    expect(screen.getByRole('dialog', { name: '模型 属性' })).toBeTruthy()
    fireEvent.pointerMove(window, { clientX: 34, clientY: 12, pointerId: 1 })
    fireEvent.pointerUp(window, { pointerId: 1 })

    await waitFor(() => expect(services.appearance.getSnapshot().ccLayout.placements.model).toMatchObject({ offsetX: 24, offsetY: -8 }))
  })

  it('控件拖拽只响应发起拖拽的 pointer', async () => {
    const { host, services } = mountPreview()
    services.appearance.dispatch({ type: 'set-cc-edit-mode', enabled: true })
    const model = await waitFor(() => {
      const value = host.querySelector<HTMLElement>('[data-widget-id="model"]')
      expect(value).not.toBeNull()
      return value!
    })

    fireEvent.pointerDown(model, { clientX: 10, clientY: 20, pointerId: 1 })
    fireEvent.pointerMove(window, { clientX: 40, clientY: 40, pointerId: 2 })
    fireEvent.pointerUp(window, { pointerId: 2 })
    expect(services.appearance.getSnapshot().ccLayout.placements.model).toMatchObject({ offsetX: 0, offsetY: 0 })

    fireEvent.pointerMove(window, { clientX: 34, clientY: 12, pointerId: 1 })
    fireEvent.pointerUp(window, { pointerId: 1 })
    expect(services.appearance.getSnapshot().ccLayout.placements.model).toMatchObject({ offsetX: 24, offsetY: -8 })
  })

  it('中控编辑工具栏可隐藏、恢复、重置并退出', async () => {
    const { host, services } = mountPreview()
    services.appearance.dispatch({ type: 'set-cc-edit-mode', enabled: true })

    expect(await screen.findByRole('toolbar', { name: '中控控件工具栏' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '隐藏 模型' }))
    await waitFor(() => expect(services.appearance.getSnapshot().ccHidden).toContain('model'))
    expect(host.querySelector('[data-widget-id="model"]')).toHaveClass('cc-hidden')

    fireEvent.click(screen.getByRole('button', { name: '显示 模型' }))
    await waitFor(() => expect(services.appearance.getSnapshot().ccHidden).not.toContain('model'))

    services.appearance.dispatch({ type: 'update-cc-placement', id: 'model', placement: { offsetX: 20 } })
    fireEvent.click(screen.getByRole('button', { name: '重置控件位置' }))
    await waitFor(() => expect(services.appearance.getSnapshot().ccLayout.placements.model.offsetX).toBe(0))

    fireEvent.click(screen.getByRole('button', { name: '退出中控编辑' }))
    await waitFor(() => expect(services.appearance.getSnapshot().ccEditMode).toBe(false))
    expect(screen.queryByRole('toolbar', { name: '中控控件工具栏' })).toBeNull()
  })

  it('属性面板可编辑槽位、顺序、偏移、缩放和 schema 外观字段', async () => {
    const { host, services } = mountPreview()
    services.appearance.dispatch({ type: 'set-cc-edit-mode', enabled: true })
    fireEvent.click(await screen.findByRole('button', { name: '模型 属性' }))

    fireEvent.change(screen.getByLabelText('控件槽位'), { target: { value: 'actions' } })
    fireEvent.input(screen.getByLabelText('控件顺序'), { target: { value: '7' } })
    fireEvent.input(screen.getByLabelText('水平微调'), { target: { value: '12' } })
    fireEvent.input(screen.getByLabelText('控件缩放'), { target: { value: '125' } })
    fireEvent.click(screen.getByRole('button', { name: '简洁' }))

    await waitFor(() => expect(services.appearance.getSnapshot().ccLayout.placements.model).toMatchObject({ slot: 'actions', order: 7, offsetX: 12 }))
    expect(services.appearance.getSnapshot().ccScale.model).toBe(125)
    expect(services.appearance.getSnapshot().modelVariant).toBe('minimal')
    expect(host.querySelector('[data-widget-id="model"] .cc-model-minimal')).toBeTruthy()
  })

  it('属性面板数字输入清空时保留上次有效值', async () => {
    const { services } = mountPreview()
    services.appearance.dispatch({ type: 'update-cc-placement', id: 'model', placement: { order: 7, offsetX: 12 } })
    services.appearance.dispatch({ type: 'set-cc-scale', id: 'model', scale: 125 })
    services.appearance.dispatch({ type: 'set-cc-edit-mode', enabled: true })
    fireEvent.click(await screen.findByRole('button', { name: '模型 属性' }))

    fireEvent.input(screen.getByLabelText('控件顺序'), { target: { value: '' } })
    fireEvent.input(screen.getByLabelText('水平微调'), { target: { value: '' } })
    fireEvent.input(screen.getByLabelText('控件缩放'), { target: { value: '' } })

    expect(services.appearance.getSnapshot().ccLayout.placements.model).toMatchObject({ order: 7, offsetX: 12 })
    expect(services.appearance.getSnapshot().ccScale.model).toBe(125)
  })

  it('属性 schema 的联动字段和条件字段在 Solid 面板中保持响应式', async () => {
    const { services } = mountPreview()
    services.appearance.dispatch({ type: 'set-cc-edit-mode', enabled: true })
    fireEvent.click(await screen.findByRole('button', { name: '输入栏 属性' }))
    fireEvent.click(screen.getByRole('button', { name: '命令行' }))

    await waitFor(() => expect(services.appearance.getSnapshot()).toMatchObject({ inputMode: 'cli', inputVariant: 'cli' }))
    const lineColor = screen.getByLabelText('边框颜色')
    fireEvent.change(lineColor, { target: { value: '#123456' } })
    await waitFor(() => expect(services.appearance.getSnapshot().ccProperties.cliLineColor).toBe('#123456'))
  })

  it('生产 HostPort 挂载路径可将属性面板修改写回 appearance 权威', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    hosts.push(host)
    const services = createPreviewWorkbenchServices()
    servicesList.push(services)
    const hostPort = createWorkbenchHostPort({
      ...services,
      suiteId: 'builtin.solid', sheetId: 'sheet-a', sessionOwnerKey: 'owner-preview', sessionId: 'preview-session',
      capabilities: { appearanceEdit: true },
    })
    const lifecycle = mountSolidWorkbenchFromHostPort({
      host,
      input: {
        sheetId: 'sheet-a', sessionOwnerKey: 'owner-preview', sessionId: 'preview-session',
        workspaceMode: 'work', replayReadonly: false, reducedMotion: true,
        visibility: 'active', rightInset: 0, preview: true,
      },
      hostPort,
    })
    services.appearance.dispatch({ type: 'set-cc-edit-mode', enabled: true })

    fireEvent.click(await screen.findByRole('button', { name: '模型 属性' }))
    fireEvent.click(screen.getByRole('button', { name: '简洁' }))

    await waitFor(() => expect(services.appearance.getSnapshot().modelVariant).toBe('minimal'))
    lifecycle.destroy()
  })

  it('编辑器可拖动整体高度，destroy 会清理窗口级拖拽监听', async () => {
    const { services, lifecycle } = mountPreview()
    services.appearance.dispatch({ type: 'set-cc-edit-mode', enabled: true })
    const initial = services.appearance.getSnapshot().ccHeight
    const handle = await screen.findByRole('separator', { name: '调整中控高度' })

    fireEvent.pointerDown(handle, { clientY: 100, pointerId: 2 })
    fireEvent.pointerMove(window, { clientY: 80, pointerId: 2 })
    await waitFor(() => expect(services.appearance.getSnapshot().ccHeight).toBe(initial + 20))

    lifecycle.destroy()
    fireEvent.pointerMove(window, { clientY: 40, pointerId: 2 })
    expect(services.appearance.getSnapshot().ccHeight).toBe(initial + 20)
  })

  it('高度拖拽只响应发起拖拽的 pointer', async () => {
    const { services } = mountPreview()
    services.appearance.dispatch({ type: 'set-cc-edit-mode', enabled: true })
    const initial = services.appearance.getSnapshot().ccHeight
    const handle = await screen.findByRole('separator', { name: '调整中控高度' })

    fireEvent.pointerDown(handle, { clientY: 100, pointerId: 1 })
    fireEvent.pointerMove(window, { clientY: 40, pointerId: 2 })
    fireEvent.pointerUp(window, { pointerId: 2 })
    expect(services.appearance.getSnapshot().ccHeight).toBe(initial)

    fireEvent.pointerMove(window, { clientY: 80, pointerId: 1 })
    fireEvent.pointerUp(window, { pointerId: 1 })
    expect(services.appearance.getSnapshot().ccHeight).toBe(initial + 20)
  })

  it('Escape 先关闭属性面板，再退出中控编辑模式', async () => {
    const { services } = mountPreview()
    services.appearance.dispatch({ type: 'set-cc-edit-mode', enabled: true })
    fireEvent.click(await screen.findByRole('button', { name: '模型 属性' }))
    expect(screen.getByRole('dialog', { name: '模型 属性' })).toBeTruthy()

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: '模型 属性' })).toBeNull()
    expect(services.appearance.getSnapshot().ccEditMode).toBe(true)

    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(services.appearance.getSnapshot().ccEditMode).toBe(false))
  })

  it('exposes ready lifecycle event and removes listeners on destroy', () => {
    const { lifecycle } = mountPreview()
    const ready = vi.fn()
    const unsubscribe = lifecycle.on('ready', ready)
    expect(ready).toHaveBeenCalledWith({ suiteId: 'builtin.solid' })
    unsubscribe()
    lifecycle.destroy()
  })

  it('Solid component render fatal is emitted through renderer lifecycle for Host fallback', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    hosts.push(host)
    const services = createPreviewWorkbenchServices()
    servicesList.push(services)
    const snapshot = services.runtime.getSnapshot()
    services.runtime.getSnapshot = () => new Proxy(snapshot, {
      get(target, property, receiver) {
        if (property === 'document') throw new Error('solid component exploded')
        return Reflect.get(target, property, receiver)
      },
    })

    const lifecycle = mountSolidWorkbench({
      host, input: { sheetId: 'sheet-a', sessionId: 'preview-session' }, services,
    })
    const error = vi.fn()
    lifecycle.on('error', error)

    await waitFor(() => expect(error).toHaveBeenCalledWith(expect.objectContaining({ message: 'solid component exploded' })))
  })

  it('Suite Host catches an initial Solid component fatal even when lifecycle subscription follows mount', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    hosts.push(host)
    const services = createPreviewWorkbenchServices()
    servicesList.push(services)
    const healthy = services.runtime.getSnapshot()
    services.runtime.getSnapshot = () => new Proxy(healthy, {
      get(target, property, receiver) {
        if (property === 'document') throw new Error('initial solid component exploded')
        return Reflect.get(target, property, receiver)
      },
    })
    const diagnostics: unknown[] = []
    const base = createWorkbenchHostPort({
      ...services, suiteId: 'builtin.solid', sheetId: 'sheet-a',
      sessionOwnerKey: 'owner-a', sessionId: 'preview-session',
    })
    const hostPort = {
      ...base,
      document: {
        getSnapshot: () => healthy.document,
        subscribe: () => () => {},
        getSlice: <T,>() => undefined as T,
        subscribeSlice: () => () => {},
      },
      diagnostics: { report: (value: unknown) => diagnostics.push(value), getRecent: () => [], subscribe: () => () => {} },
    }
    const suite: RendererSuiteContribution = {
      id: 'builtin.solid', label: 'Builtin Solid', apiVersion: 1,
      runtime: { framework: 'solid', version: '1' },
      compatibility: { documentSchema: 'workbench.v1', renderCatalogSchema: 1 },
      requiredKinds: ['content.unknown'],
      factory: {
        async prepare() {
          return { mount(container, input) { return mountSolidWorkbench({ host: container, input, services }) } }
        },
      },
    }
    const activation: RendererActivationSnapshot = {
      revision: 1,
      suite: { ownerPluginId: 'builtin.pylon-renderers', ownerRuntimeInstanceId: 'runtime', contributionId: suite.id, layer: 'feature', priority: 1, value: suite } as RegistryEntry<RendererSuiteContribution>,
      kinds: new Map(), slots: new Map(), diagnostics: [],
    }
    const suiteHost = new RendererSuiteHost({
      container: host, hostPort: hostPort as never,
      input: {
        sheetId: 'sheet-a', sessionOwnerKey: 'owner-a', sessionId: 'preview-session', workspaceMode: 'work',
        replayReadonly: false, reducedMotion: false, visibility: 'active', rightInset: 0, preview: false,
      },
    })

    await suiteHost.mount(activation)

    expect(suiteHost.getState().phase).toBe('degraded')
    expect(diagnostics).toContainEqual(expect.objectContaining({
      code: 'renderer.suite.switch.failed', phase: 'mount', recoverability: 'retry',
      message: 'initial solid component exploded',
    }))
    await suiteHost.destroy()
  })

  it('通过 Suite Host 注入的 HostPort 由宿主管理，renderer destroy 不销毁共享 diagnostics', () => {
    const host = document.createElement('div')
    document.body.append(host)
    hosts.push(host)
    const services = createPreviewWorkbenchServices()
    servicesList.push(services)
    const hostPort = createWorkbenchHostPort({
      ...services, suiteId: 'builtin.solid', sheetId: 'sheet-a',
      sessionOwnerKey: 'owner-a', sessionId: 'preview-session',
    })
    const destroyDiagnostics = vi.spyOn(hostPort.diagnostics, 'destroy')
    const lifecycle = mountSolidWorkbench({
      host, input: { sheetId: 'sheet-a', sessionId: 'preview-session' }, services, hostPort,
    })

    lifecycle.destroy()

    expect(destroyDiagnostics).not.toHaveBeenCalled()
  })

  it('document apply 驱动消息、活动、usage 与 diagnostics surface', async () => {
    const { host, services } = mountPreview()
    const envelope = (sequence: number, event: WorkbenchEventEnvelope['event']): WorkbenchEventEnvelope => createWorkbenchEnvelope({
      sessionId: 'preview-session', recordedAt: `2026-08-21T00:00:0${sequence}.000Z`, sequence,
      source: { provider: 'peri', sourceId: `solid-${sequence}` }, provenance: { origin: 'local-observed', trust: 'authoritative' }, event,
    })
    const workbenchDocument = projectWorkbench([
      envelope(1, { type: 'message.delta', role: 'assistant', parts: [{ kind: 'text', text: 'canonical answer' }] }),
      envelope(2, { type: 'tool.started', tool: { toolCallId: 'tool-1', name: 'Read', status: 'running' } }),
      envelope(3, { type: 'usage.updated', usage: { inputTokens: 8 } }),
      envelope(4, { type: 'diagnostic.notice', level: 'warning', code: 'demo.warning', message: 'canonical warning' }),
      envelope(5, { type: 'budget.warning', used: 90, limit: 100, remaining: 10, exhausted: false }),
      envelope(6, { type: 'session.config-updated', options: [{ id: 'model', label: 'Model', value: 'gpt-5', version: 1 }] }),
      envelope(7, { type: 'session.commands-updated', commands: [{ id: 'review', name: '/review', description: '审查改动' }] }),
      envelope(8, { type: 'assist.prediction', placeholder: '继续审计', actions: [] }),
      envelope(9, { type: 'assist.file-suggestions', files: ['src/a.ts'] }),
    ]).document
    services.runtime.replaceDocument(workbenchDocument, { ownerKey: 'owner-preview', generation: 1 })
    await waitFor(() => expect(screen.getByText('canonical answer')).toBeTruthy())
    expect(host.querySelector('[data-activity-count="1"]')).toBeTruthy()
    expect(host.querySelector('[data-has-usage="true"]')).toBeTruthy()
    expect(screen.getByLabelText('会话用量')).toHaveTextContent('输入 8')
    expect(screen.getByLabelText('会话预算')).toHaveTextContent('剩余 10')
    expect(screen.getByLabelText('编辑 Model')).toHaveValue('gpt-5')
    expect(screen.getByLabelText('会话命令')).toHaveTextContent('/review')
    expect(screen.getByLabelText('输入预测')).toHaveTextContent('继续审计')
    expect(screen.getByLabelText('文件建议')).toHaveTextContent('src/a.ts')
    await waitFor(() => expect(host.textContent).toContain('↓ 8 tokens'))
    expect(host.querySelector('[data-widget-id="tokens"]')).toHaveTextContent('8/—')
    expect(screen.getByText('canonical warning')).toBeTruthy()
  })

  it('C04 canonical unknown tool uses the typed tool.generic base Slot and updates without remount', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    hosts.push(host)
    const services = createPreviewWorkbenchServices()
    servicesList.push(services)
    const slot = createBuiltinSolidContentSlot()
    const slotEntry = {
      ownerPluginId: 'builtin.pylon-renderers', ownerRuntimeInstanceId: 'runtime',
      contributionId: slot.id, layer: 'feature', priority: slot.priority, value: slot,
    } as RegistryEntry<RendererSlotContribution>
    const suite = { id: 'builtin.solid' } as RendererSuiteContribution
    const kindEntries = BUILTIN_TOOL_RENDER_KINDS.map(kind => [kind.id, {
      ownerPluginId: 'core.renderer.tool-kinds', ownerRuntimeInstanceId: 'runtime',
      contributionId: kind.id, layer: 'feature', priority: kind.priority, value: kind,
    } as RegistryEntry<(typeof BUILTIN_TOOL_RENDER_KINDS)[number]>] as const)
    const specializedToolKind = {
      ...BUILTIN_TOOL_RENDER_KINDS[0]!, id: 'tool.unregistered', fallbackKind: 'tool.generic',
      fixture: { id: 'fixture-specialized', name: 'SpecializedTool', status: 'running', semanticKind: 'tool.unregistered' },
    }
    const specializedToolEntry = {
      ownerPluginId: 'core.renderer.semantic-kinds', ownerRuntimeInstanceId: 'runtime',
      contributionId: specializedToolKind.id, layer: 'feature', priority: specializedToolKind.priority,
      value: specializedToolKind,
    } as RegistryEntry<typeof specializedToolKind>
    const activation: RendererActivationSnapshot = {
      revision: 1,
      suite: {
        ownerPluginId: 'builtin.pylon-renderers', ownerRuntimeInstanceId: 'runtime',
        contributionId: suite.id, layer: 'feature', priority: 1, value: suite,
      } as RegistryEntry<RendererSuiteContribution>,
      kinds: new Map([...kindEntries, ['tool.unregistered', specializedToolEntry]]),
      slots: new Map(BUILTIN_TOOL_RENDER_KINDS.map(kind => [kind.id, [slotEntry]])),
      diagnostics: [],
    }
    mountSolidWorkbench({
      host,
      input: { sheetId: 'sheet-a', sessionId: 'preview-session' },
      services,
      activation,
    })
    const started = projectWorkbench([createWorkbenchEnvelope({
      sessionId: 'preview-session', recordedAt: '2026-08-22T00:00:01.000Z', sequence: 1,
      source: { provider: 'peri', sourceId: 'tool-start' }, identity: { toolCallId: 'tool-c04' },
      provenance: { origin: 'local-observed', trust: 'authoritative' },
      event: {
        type: 'tool.started',
        tool: {
          name: 'ProviderRead', canonicalName: 'read_file', title: '读取文件',
          semanticKind: 'tool.unregistered', status: 'running', input: { path: '/normalized.txt' },
        },
      },
    })]).document

    services.runtime.replaceDocument(started, { ownerKey: 'owner-preview', generation: 1 })

    const card = await screen.findByRole('status', { name: '工具：读取文件，运行中' })
    expect(card).toHaveAttribute('data-content-kind', 'tool.generic')
    expect(card).toHaveTextContent('ProviderRead')
    expect(card).toHaveTextContent('/normalized.txt')
    expect(host.querySelector('.solid-workbench-activity')).toBeNull()
    expect(card.closest('[data-renderer-slot-id="builtin.solid.content.base"]')).not.toBeNull()

    const completed = reduceWorkbenchEvent(started, createWorkbenchEnvelope({
      sessionId: 'preview-session', recordedAt: '2026-08-22T00:00:02.000Z', sequence: 2,
      source: { provider: 'peri', sourceId: 'tool-complete' }, identity: { toolCallId: 'tool-c04' },
      provenance: { origin: 'local-observed', trust: 'authoritative' },
      event: { type: 'tool.completed', tool: { status: 'completed', parts: [{ kind: 'text', text: 'file body' }], durationMs: 1200 } },
    }))
    services.runtime.replaceDocument(completed, { ownerKey: 'owner-preview', generation: 1 })

    await waitFor(() => expect(card).toHaveAccessibleName('工具：读取文件，已完成'))
    expect(screen.getByRole('status', { name: '工具：读取文件，已完成' })).toBe(card)
    expect(card).toHaveTextContent('file body')
    expect(card).toHaveTextContent('1.2s')
    const cardHead = card.querySelector<HTMLButtonElement>('.term-tool-head')!
    fireEvent.click(cardHead)
    expect(cardHead).toHaveAttribute('aria-expanded', 'false')

    const nested = reduceWorkbenchEvent(completed, createWorkbenchEnvelope({
      sessionId: 'preview-session', recordedAt: '2026-08-22T00:00:03.000Z', sequence: 3,
      source: { provider: 'peri', sourceId: 'tool-child' }, identity: { toolCallId: 'tool-c04-child' },
      provenance: { origin: 'local-observed', trust: 'authoritative' },
      event: {
        type: 'tool.started',
        tool: { name: 'ChildTool', title: '子工具', semanticKind: 'tool.unregistered', parentToolUseId: 'tool-c04' },
      },
    }))
    services.runtime.replaceDocument(nested, { ownerKey: 'owner-preview', generation: 1 })

    const connector = await waitFor(() => {
      const value = host.querySelector<HTMLElement>('[data-from-message-id="tool-c04"][data-to-message-id="tool-c04-child"]')
      expect(value).not.toBeNull()
      return value!
    })
    expect(connector).toHaveClass('term-tool-connector')

    const replacement = projectWorkbench([createWorkbenchEnvelope({
      sessionId: 'preview-session', recordedAt: '2026-08-22T00:00:04.000Z', sequence: 4,
      source: { provider: 'peri', sourceId: 'tool-replacement' }, identity: { toolCallId: 'tool-replacement' },
      provenance: { origin: 'local-observed', trust: 'authoritative' },
      event: { type: 'tool.started', tool: { name: 'Replacement', title: '替换工具', semanticKind: 'tool.unregistered' } },
    })]).document
    services.runtime.replaceDocument(replacement, { ownerKey: 'owner-preview', generation: 2 })

    const replacementCard = await screen.findByRole('status', { name: '工具：替换工具，运行中' })
    expect(replacementCard).toBe(card)
    expect(replacementCard.querySelector('.term-tool-head')).toHaveAttribute('aria-controls', 'solid-tool-snapshot-tool-replacement')
    expect(replacementCard.querySelector('.term-tool-head')).toHaveAttribute('aria-expanded', 'true')
    expect(replacementCard.querySelector('#solid-tool-snapshot-tool-replacement')).not.toBeNull()
    expect(host.querySelector('[data-from-message-id="tool-c04"]')).toBeNull()
  })

  it('canonical media part reaches the committed Solid media renderer in production', async () => {
    const { services } = mountPreview()
    const document = projectWorkbench([createWorkbenchEnvelope({
      sessionId: 'preview-session', recordedAt: '2026-08-21T00:00:01.000Z', sequence: 1,
      source: { provider: 'hermes', sourceId: 'media-1' },
      provenance: { origin: 'local-observed', trust: 'authoritative' },
      event: {
        type: 'message.delta', role: 'assistant',
        parts: [{ kind: 'image', source: 'https://cdn.example.com/architecture.png', alt: '架构图' }],
      },
    })]).document

    services.runtime.replaceDocument(document, { ownerKey: 'owner-preview', generation: 1 })

    expect(await screen.findByRole('img', { name: '架构图' })).toHaveAttribute(
      'src', 'https://cdn.example.com/architecture.png',
    )
  })

  it('C06 canonical diff and LSP parts reach their production base Slot kinds', async () => {
    const { host, services } = mountPreview()
    const document = projectWorkbench([createWorkbenchEnvelope({
      sessionId: 'preview-session', recordedAt: '2026-08-23T00:00:01.000Z', sequence: 1,
      source: { provider: 'peri', sourceId: 'c06-content' }, identity: { messageId: 'c06-content' },
      provenance: { origin: 'local-observed', trust: 'authoritative' },
      event: {
        type: 'message.delta', role: 'assistant', parts: [
          { kind: 'diff', path: '/src/production.ts', lines: [{ kind: 'added', text: 'export const ready = true' }] },
          { kind: 'diagnostic-lsp', severity: 'error', code: 'TS1005', message: 'semicolon expected', path: '/src/production.ts' },
        ],
      },
    })]).document

    services.runtime.replaceDocument(document, { ownerKey: 'owner-preview', generation: 1 })

    expect(await screen.findByRole('region', { name: 'Diff：/src/production.ts' })).toBeTruthy()
    expect(await screen.findByRole('alert', { name: 'LSP error：semicolon expected' })).toBeTruthy()
    expect(host.querySelector('[data-content-kind="content.diff"] [data-renderer-slot-id="builtin.solid.content.base"]')
      ?? host.querySelector('[data-content-kind="content.diff"]')).not.toBeNull()
    expect(host.querySelector('[data-content-kind="diagnostic.lsp"]')).not.toBeNull()
  })

  it('C07 canonical terminal and log parts remain readable through the production fallback', async () => {
    const { host, services } = mountPreview()
    const document = projectWorkbench([createWorkbenchEnvelope({
      sessionId: 'preview-session', recordedAt: '2026-08-23T00:00:02.000Z', sequence: 1,
      source: { provider: 'hermes', sourceId: 'c07-content' }, identity: { messageId: 'c07-content' },
      provenance: { origin: 'local-observed', trust: 'authoritative' },
      event: {
        type: 'message.delta', role: 'assistant', parts: [
          { kind: 'terminal', command: 'npm test', streams: [{ stream: 'stderr', text: 'failed', ordinal: 0 }], exitCode: 1 },
          { kind: 'log', source: 'runner', entries: [{ level: 'info', text: 'cleanup complete' }] },
        ],
      },
    })]).document

    services.runtime.replaceDocument(document, { ownerKey: 'owner-preview', generation: 1 })

    await waitFor(() => expect(host.querySelector('.term-terminal-card')).toHaveTextContent('failed'))
    expect(host.querySelector('.term-log-card')).toHaveTextContent('cleanup complete')
    expect(host.textContent).not.toContain('Unsupported content kind')
  })

  it('C15 canonical content and negotiated extension events reach production Slots and missing-plugin fallback', async () => {
    const { host, services } = mountPreview()
    const make = (sequence: number, event: WorkbenchEventEnvelope['event']) => createWorkbenchEnvelope({
      sessionId: 'preview-session', recordedAt: `2026-08-24T00:00:0${sequence}.000Z`, sequence,
      source: { provider: 'peri', sourceId: `c15-${sequence}` }, identity: { messageId: sequence === 1 ? 'c15-message' : undefined },
      provenance: { origin: 'local-observed', trust: 'authoritative' }, event,
    })
    const document = projectWorkbench([
      make(1, { type: 'message.delta', role: 'assistant', parts: [{ kind: 'artifact', artifactId: 'artifact-1', title: 'Production report', uri: 'artifact://report', parts: [{ kind: 'text', text: 'preview body' }] }] }),
      make(2, { type: 'extension.event', kind: 'system.hook', payload: { phase: 'turn.completed', owner: { pluginId: 'plugin.audit', handlerId: 'after' }, status: 'continued', durationMs: 11 }, fallback: [] }),
      make(3, { type: 'extension.event', kind: 'plugin.removed/result', payload: { status: 'done' }, fallback: [{ kind: 'unknown', originalType: 'plugin.removed/result', summary: 'renderer unavailable', raw: { status: 'done' }, truncated: false }] }),
    ]).document

    services.runtime.replaceDocument(document, { ownerKey: 'owner-preview', generation: 1 })

    expect(await screen.findByRole('article', { name: '工件：Production report' })).toHaveTextContent('preview body')
    expect(await screen.findByRole('status', { name: 'Hook：turn.completed' })).toHaveTextContent('11 ms')
    const missingPlugin = await screen.findByRole('note', { name: '扩展事件：plugin.removed/result' })
    expect(missingPlugin).toHaveTextContent('renderer unavailable')
    expect(missingPlugin).toHaveTextContent('peri · c15-3')
    expect(missingPlugin).toHaveTextContent('local-observed · authoritative')
    expect(host.querySelector('[data-extension-kind="plugin.removed/result"]')).not.toBeNull()
  })

  it('C10 workflow remains readable through the built-in no-Slot fallback', async () => {
    const { host, services } = mountPreview()
    const projected = projectWorkbench([createWorkbenchEnvelope({
      sessionId: 'preview-session', recordedAt: '2026-08-24T00:00:01.000Z', sequence: 1,
      source: { provider: 'peri', sourceId: 'workflow-fallback' }, identity: { taskId: 'workflow-fallback' },
      provenance: { origin: 'local-observed', trust: 'authoritative' },
      event: {
        type: 'activity.started', activityId: 'workflow-fallback',
        activity: { kind: 'workflow', title: 'fallback workflow' },
      },
    })]).document

    services.runtime.replaceDocument(projected, { ownerKey: 'owner-preview', generation: 1 })

    await waitFor(() => expect(host.querySelector('.term-workflow-card')).toHaveTextContent('fallback workflow'))
    expect(host.querySelector('.term-subagent-card')).toBeNull()
  })

  it('C07 activity.process renders identity, output, status, and synthetic provenance outside messages', async () => {
    const { host, services } = mountPreview()
    const createActivity = (sequence: number, event: WorkbenchEventEnvelope['event']) => createWorkbenchEnvelope({
      sessionId: 'preview-session', recordedAt: `2026-08-23T00:00:0${sequence}.000Z`, sequence,
      source: { provider: 'peri', sourceId: `process-${sequence}` }, identity: { taskId: 'process-1' },
      provenance: sequence === 1
        ? { origin: 'local-observed', trust: 'authoritative' }
        : { origin: 'plugin', trust: 'unverified', orderConfidence: 'observed', synthetic: { reason: 'observed exit' } },
      event,
    })
    const workbenchDocument = projectWorkbench([
      createActivity(1, {
        type: 'activity.started', activityId: 'process-1',
        activity: { kind: 'process', title: 'background tests', processId: 'pid-7', sessionId: 'shell-2' },
      }),
      createActivity(2, {
        type: 'activity.completed', activityId: 'process-1',
        result: { parts: [{ kind: 'terminal', streams: [{ stream: 'stdout', text: 'all passed', ordinal: 0 }], exitCode: 0 }] },
      }),
    ]).document

    services.runtime.replaceDocument(workbenchDocument, { ownerKey: 'owner-preview', generation: 1 })

    await waitFor(() => expect(host.querySelector('.term-process-activity')).toHaveTextContent('background tests'))
    const process = host.querySelector('.term-process-activity')!
    expect(process).toHaveTextContent('pid-7')
    expect(process).toHaveTextContent('shell-2')
    expect(process).toHaveTextContent('completed')
    expect(process).toHaveTextContent('all passed')
    expect(process).toHaveTextContent('合成生命周期：observed exit')
    expect([...host.querySelectorAll('[data-message-role]')].map(node => node.textContent).join('')).not.toContain('all passed')
  })

  it('C07 terminal/log/process kinds mount through the production base Slot', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    hosts.push(host)
    const services = createPreviewWorkbenchServices()
    servicesList.push(services)
    const slot = createBuiltinSolidContentSlot()
    const slotEntry = {
      ownerPluginId: 'builtin.pylon-renderers', ownerRuntimeInstanceId: 'runtime',
      contributionId: slot.id, layer: 'feature', priority: slot.priority, value: slot,
    } as RegistryEntry<RendererSlotContribution>
    const kinds = [
      ...BUILTIN_TEXT_RENDER_KINDS.filter(kind => kind.id === 'content.terminal' || kind.id === 'content.log'),
      ...BUILTIN_EXECUTION_RENDER_KINDS,
    ]
    const activation: RendererActivationSnapshot = {
      revision: 1,
      suite: {
        ownerPluginId: 'builtin.pylon-renderers', ownerRuntimeInstanceId: 'runtime',
        contributionId: 'builtin.solid', layer: 'feature', priority: 1, value: { id: 'builtin.solid' } as RendererSuiteContribution,
      },
      kinds: new Map(kinds.map(kind => [kind.id, {
        ownerPluginId: 'core.renderer.execution', ownerRuntimeInstanceId: 'runtime',
        contributionId: kind.id, layer: 'feature', priority: kind.priority, value: kind,
      }])),
      slots: new Map(kinds.map(kind => [kind.id, [slotEntry]])),
      diagnostics: [],
    }
    mountSolidWorkbench({
      host, input: { sheetId: 'sheet-a', sessionId: 'preview-session' }, services, activation,
    })
    const make = (sequence: number, event: WorkbenchEventEnvelope['event']) => createWorkbenchEnvelope({
      sessionId: 'preview-session', sequence, recordedAt: `2026-08-23T00:01:0${sequence}.000Z`,
      source: { provider: 'hermes', sourceId: `c07-slot-${sequence}` },
      identity: event.type.startsWith('message.') ? { messageId: 'message-slot' } : { taskId: 'process-slot' },
      provenance: { origin: 'local-observed', trust: 'authoritative' }, event,
    })
    const workbenchDocument = projectWorkbench([
      make(1, { type: 'message.delta', role: 'assistant', parts: [
        { kind: 'terminal', streams: [{ stream: 'stdout', text: 'slot terminal' }] },
        { kind: 'log', entries: [{ level: 'info', text: 'slot log' }] },
      ] }),
      make(2, { type: 'activity.started', activityId: 'process-slot', activity: {
        kind: 'process', semanticKind: 'activity.process', title: 'slot process', processId: 'pid-slot',
      } }),
    ]).document
    services.runtime.replaceDocument(workbenchDocument, { ownerKey: 'owner-preview', generation: 1 })

    await waitFor(() => expect(host.querySelector('[data-renderer-slot-id="builtin.solid.content.base"] .term-terminal-card')).toHaveTextContent('slot terminal'))
    expect(host.querySelector('[data-renderer-slot-id="builtin.solid.content.base"] .term-log-card')).toHaveTextContent('slot log')
    expect(host.querySelector('[data-renderer-slot-id="builtin.solid.content.base"] .term-process-activity')).toHaveTextContent('slot process')
  })

  it('canonical reasoning terminal metadata reaches the production content Slot', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    hosts.push(host)
    const services = createPreviewWorkbenchServices()
    servicesList.push(services)
    const slot = createBuiltinSolidContentSlot()
    const slotEntry = {
      ownerPluginId: 'builtin.pylon-renderers', ownerRuntimeInstanceId: 'runtime',
      contributionId: slot.id, layer: 'feature', priority: slot.priority, value: slot,
    } as RegistryEntry<RendererSlotContribution>
    const kindEntries = BUILTIN_TEXT_RENDER_KINDS
      .filter(kind => kind.id === 'content.reasoning' || kind.id === 'content.redacted-reasoning')
      .map(kind => [kind.id, {
        ownerPluginId: 'core.renderer.text-kinds', ownerRuntimeInstanceId: 'runtime',
        contributionId: kind.id, layer: 'feature', priority: kind.priority, value: kind,
      } as RegistryEntry<(typeof BUILTIN_TEXT_RENDER_KINDS)[number]>] as const)
    const suite = { id: 'builtin.solid' } as RendererSuiteContribution
    const activation: RendererActivationSnapshot = {
      revision: 1,
      suite: {
        ownerPluginId: 'builtin.pylon-renderers', ownerRuntimeInstanceId: 'runtime',
        contributionId: suite.id, layer: 'feature', priority: 1, value: suite,
      } as RegistryEntry<RendererSuiteContribution>,
      kinds: new Map(kindEntries),
      slots: new Map([
        ['content.reasoning', [slotEntry]],
        ['content.redacted-reasoning', [slotEntry]],
      ]),
      diagnostics: [],
    }
    mountSolidWorkbench({
      host,
      input: { sheetId: 'sheet-a', sessionId: 'preview-session' },
      services,
      activation,
    })
    const envelope = (
      sequence: number,
      event: WorkbenchEventEnvelope['event'],
      messageId: string,
      occurredAt: string,
    ) => createWorkbenchEnvelope({
      sessionId: 'preview-session', sequence, recordedAt: occurredAt, occurredAt,
      source: { provider: 'claude', sourceId: `reasoning-${sequence}` },
      identity: { messageId },
      provenance: { origin: 'local-observed', trust: 'authoritative' }, event,
    })
    const projected = projectWorkbench([
      envelope(1, { type: 'reasoning.delta', parts: [{ kind: 'reasoning', text: 'visible thought' }] }, 'thought-visible', '2026-08-21T00:00:01.000Z'),
      envelope(2, { type: 'reasoning.completed', parts: [] }, 'thought-visible', '2026-08-21T00:00:03.400Z'),
      envelope(3, { type: 'reasoning.redacted', parts: [{ kind: 'redacted-reasoning', reason: 'provider_policy' }], reason: 'provider_policy' }, 'thought-redacted', '2026-08-21T00:00:04.000Z'),
    ]).document

    services.runtime.replaceDocument(projected, { ownerKey: 'owner-preview', generation: 1 })

    expect(await screen.findByRole('button', { name: /Thought for 2\.4s/ })).toBeTruthy()
    expect(await screen.findByText('provider_policy')).toBeTruthy()
    expect(host.querySelector('[data-content-kind="content.reasoning"]')).not.toBeNull()
    expect(host.querySelector('[data-content-kind="content.redacted-reasoning"]')).not.toBeNull()
  })

  it('keeps C02 documents visible through the built-in no-Slot fallback', async () => {
    const { host, services } = mountPreview()
    const projected = projectWorkbench([createWorkbenchEnvelope({
      sessionId: 'preview-session', sequence: 1,
      recordedAt: '2026-08-22T00:00:01.000Z', occurredAt: '2026-08-22T00:00:01.000Z',
      source: { provider: 'peri', sourceId: 'document-fallback' }, identity: { messageId: 'document-fallback' },
      provenance: { origin: 'local-observed', trust: 'authoritative' },
      event: {
        type: 'message.delta', role: 'assistant',
        parts: [{ kind: 'document', title: 'fallback-spec.md', text: 'fallback document body', mimeType: 'text/markdown' }],
      },
    })]).document

    services.runtime.replaceDocument(projected, { ownerKey: 'owner-preview', generation: 1 })

    expect(await screen.findByText('fallback-spec.md')).toBeTruthy()
    expect(await screen.findByText('fallback document body')).toBeTruthy()
    expect(host.querySelector('[data-part-kind="document"]')).not.toBeNull()
    expect(host.textContent).not.toContain('Unsupported content kind: document')
  })

  it('interaction 只提交 normalized optionId，不自造 provider approval payload', async () => {
    const { services } = mountPreview({ interactionResponse: true })
    const document = projectWorkbench([createWorkbenchEnvelope({
      sessionId: 'preview-session', recordedAt: '2026-08-21T00:00:01.000Z', sequence: 1,
      source: { provider: 'peri', sourceId: 'interaction-1' }, identity: { interactionId: 'interaction-1' },
      provenance: { origin: 'local-observed', trust: 'authoritative' },
      event: {
        type: 'interaction.requested', interactionId: 'interaction-1',
        request: {
          surface: 'interaction', kind: 'approval', state: 'waiting',
          identity: { provider: 'peri', agentId: 'peri', requestId: 'request-1', sessionId: 'preview-session', clientGeneration: 3 },
          questions: [{ id: 'approval', question: 'Allow edit?', allowMultiple: false, allowFreeform: false,
            options: [{ id: 'allow_once', label: 'Allow once' }, { id: 'reject_once', label: 'Reject' }] }],
        },
      },
    })]).document
    services.runtime.replaceDocument(document, { ownerKey: 'owner-preview', generation: 1 })
    const allowButton = await screen.findByRole('button', { name: 'Allow once' })
    expect(allowButton.closest('.interaction-card')).not.toBeNull()

    fireEvent.click(allowButton)

    await waitFor(() => expect(services.commands.calls).toContainEqual({
      // A09 补全：按钮随响应携带 expectedRevision（document.sequence）供 transport 层 stale 防护
      command: 'respondInteraction', args: ['preview-session', 'interaction-1', { optionId: 'allow_once' }, { expectedRevision: 1 }],
    }))
  })

  it('interaction command failure keeps the answer editable and reports the rejection', async () => {
    const { services } = mountPreview({ interactionResponse: true })
    services.commands.setHandler('respondInteraction', async () => ({ ok: false, error: 'policy denied' }))
    services.runtime.replaceDocument(projectWorkbench([createWorkbenchEnvelope({
      sessionId: 'preview-session', recordedAt: '2026-08-21T00:00:01.000Z', sequence: 2,
      source: { provider: 'peri', sourceId: 'interaction-failure' }, identity: { interactionId: 'interaction-failure' },
      provenance: { origin: 'local-observed', trust: 'authoritative' },
      event: {
        type: 'interaction.requested', interactionId: 'interaction-failure',
        request: {
          surface: 'interaction', kind: 'ask-question', state: 'waiting',
          identity: { provider: 'peri', agentId: 'peri', requestId: 'request-failure', sessionId: 'preview-session', clientGeneration: 3 },
          questions: [{ id: 'reason', question: '为什么继续？', allowMultiple: false, allowFreeform: true, options: [] }],
        },
      },
    })]).document, { ownerKey: 'owner-preview', generation: 1 })

    const input = await screen.findByPlaceholderText('输入回答后回车') as HTMLInputElement
    fireEvent.input(input, { target: { value: '仍需完成验证' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(await screen.findByRole('alert')).toHaveTextContent('policy denied')
    expect(input).toHaveValue('仍需完成验证')
  })

  it('routes canonical interactions through a Suite-local replaceable Slot', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    hosts.push(host)
    const services = createPreviewWorkbenchServices()
    servicesList.push(services)
    const kind = BUILTIN_INTERACTION_RENDER_KINDS.find(item => item.id === 'interaction.approval')!
    const slot: RendererSlotContribution = {
      id: 'plugin.interaction.approval', targetSuites: ['builtin.solid'], kinds: [kind.id], priority: 20_000,
      fallback: false, canRender: () => true,
      createSurface: () => ({
        rendererId: 'plugin.interaction.approval', kind: 'solid',
        mount(container) {
          const node = document.createElement('div')
          node.textContent = 'Plugin approval surface'
          container.append(node)
          return node
        },
        update() {}, destroy(handle) { (handle as HTMLElement).remove() }, on: () => () => {},
      }),
    }
    const suite = { id: 'builtin.solid' } as RendererSuiteContribution
    const kindEntry = { ownerPluginId: 'core.interaction', ownerRuntimeInstanceId: 'runtime', contributionId: kind.id,
      layer: 'feature', priority: kind.priority, value: kind } as RegistryEntry<typeof kind>
    const slotEntry = { ownerPluginId: 'plugin.interaction', ownerRuntimeInstanceId: 'runtime', contributionId: slot.id,
      layer: 'feature', priority: slot.priority, value: slot } as RegistryEntry<RendererSlotContribution>
    const activation: RendererActivationSnapshot = {
      revision: 1,
      suite: { ownerPluginId: 'builtin.pylon-renderers', ownerRuntimeInstanceId: 'runtime', contributionId: suite.id,
        layer: 'feature', priority: 1, value: suite } as RegistryEntry<RendererSuiteContribution>,
      kinds: new Map([[kind.id, kindEntry]]), slots: new Map([[kind.id, [slotEntry]]]), diagnostics: [],
    }
    mountSolidWorkbench({ host, input: { sheetId: 'sheet-a', sessionId: 'preview-session' }, services, activation })
    services.runtime.replaceDocument(projectWorkbench([createWorkbenchEnvelope({
      sessionId: 'preview-session', recordedAt: '2026-08-21T00:00:01.000Z', sequence: 1,
      source: { provider: 'peri', sourceId: 'replaceable-interaction' }, identity: { interactionId: 'replaceable-interaction' },
      provenance: { origin: 'local-observed', trust: 'authoritative' },
      event: {
        type: 'interaction.requested', interactionId: 'replaceable-interaction',
        request: { surface: 'interaction', kind: 'approval', state: 'waiting',
          identity: { provider: 'peri', agentId: 'peri', requestId: 'replaceable', sessionId: 'preview-session', clientGeneration: 1 },
          questions: [{ id: 'approval', question: 'Replace me?', allowMultiple: false, allowFreeform: false, options: [] }] },
      },
    })]).document, { ownerKey: 'owner-preview', generation: 1 })

    expect(await screen.findByText('Plugin approval surface')).toBeTruthy()
    expect(host.querySelector('.interaction-card')).toBeNull()
  })

  it('gives a C12 plugin replacement only the redacted canonical interaction snapshot', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    hosts.push(host)
    const services = createPreviewWorkbenchServices()
    servicesList.push(services)
    const kind = BUILTIN_INTERACTION_RENDER_KINDS.find(item => item.id === 'interaction.secret')!
    let pluginSnapshot = ''
    const slot: RendererSlotContribution = {
      id: 'plugin.interaction.secret', targetSuites: ['builtin.solid'], kinds: [kind.id], priority: 20_000,
      fallback: false, canRender: () => true,
      createSurface: () => ({
        rendererId: 'plugin.interaction.secret', kind: 'solid',
        mount(container, snapshot) {
          pluginSnapshot = JSON.stringify(snapshot)
          const node = document.createElement('div')
          node.textContent = 'Plugin secret surface'
          container.append(node)
          return node
        },
        update(_handle, snapshot) { pluginSnapshot = JSON.stringify(snapshot) },
        destroy(handle) { (handle as HTMLElement).remove() }, on: () => () => {},
      }),
    }
    const suite = { id: 'builtin.solid' } as RendererSuiteContribution
    const kindEntry = { ownerPluginId: 'core.interaction', ownerRuntimeInstanceId: 'runtime', contributionId: kind.id,
      layer: 'feature', priority: kind.priority, value: kind } as RegistryEntry<typeof kind>
    const slotEntry = { ownerPluginId: 'plugin.interaction', ownerRuntimeInstanceId: 'runtime', contributionId: slot.id,
      layer: 'feature', priority: slot.priority, value: slot } as RegistryEntry<RendererSlotContribution>
    const activation: RendererActivationSnapshot = {
      revision: 1,
      suite: { ownerPluginId: 'builtin.pylon-renderers', ownerRuntimeInstanceId: 'runtime', contributionId: suite.id,
        layer: 'feature', priority: 1, value: suite } as RegistryEntry<RendererSuiteContribution>,
      kinds: new Map([[kind.id, kindEntry]]), slots: new Map([[kind.id, [slotEntry]]]), diagnostics: [],
    }
    mountSolidWorkbench({ host, input: { sheetId: 'sheet-a', sessionId: 'preview-session' }, services, activation })
    const credential = 'c12-plugin-secret'
    services.runtime.replaceDocument(projectWorkbench([createWorkbenchEnvelope({
      sessionId: 'preview-session', recordedAt: '2026-08-21T00:00:01.000Z', sequence: 1,
      source: { provider: 'peri', sourceId: 'replaceable-secret' }, identity: { interactionId: 'replaceable-secret' },
      provenance: { origin: 'local-observed', trust: 'authoritative' },
      event: {
        type: 'interaction.requested', interactionId: 'replaceable-secret',
        request: { surface: 'interaction', kind: 'secret', state: 'waiting', value: credential,
          identity: { provider: 'peri', agentId: 'peri', requestId: 'secret-1', sessionId: 'preview-session', toolCallId: null, clientGeneration: 1 },
          questions: [{ id: 'secret', question: 'Credential', allowMultiple: false, allowFreeform: true, options: [] }] },
      },
    })]).document, { ownerKey: 'owner-preview', generation: 1 })

    expect(await screen.findByText('Plugin secret surface')).toBeTruthy()
    expect(pluginSnapshot).not.toContain(credential)
    expect(pluginSnapshot).toContain('valueRedacted')
  })

  it('Slot semantic action 穿过 Host command capability gate，不被 lifecycle 静默丢弃', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    hosts.push(host)
    const services = createPreviewWorkbenchServices()
    servicesList.push(services)
    const hostPort = createWorkbenchHostPort({
      ...services, suiteId: 'builtin.solid', sheetId: 'sheet-a',
      sessionOwnerKey: 'owner-a', sessionId: 'preview-session',
      capabilities: { clipboardWrite: true },
    })
    const slot: RendererSlotContribution = {
      id: 'test.semantic-action', targetSuites: ['builtin.solid'], kinds: ['message.assistant'],
      priority: 1, fallback: false, canRender: () => true,
      createSurface: () => ({
        rendererId: 'test.semantic-action', kind: 'solid',
        mount(container, _snapshot, _appearance, commands) {
          const button = document.createElement('button')
          button.textContent = 'copy through semantic port'
          button.addEventListener('click', () => { void commands.execute({ type: 'clipboard.write', payload: { text: 'semantic copy' } }) })
          container.append(button)
          return button
        },
        update() {}, destroy(handle) { (handle as HTMLElement).remove() }, on: () => () => {},
      }),
    }
    const entry = { ownerPluginId: 'test.semantic-action', ownerRuntimeInstanceId: 'runtime', contributionId: slot.id, layer: 'feature', priority: 1, value: slot } as RegistryEntry<RendererSlotContribution>
    const suite = { id: 'builtin.solid' } as RendererSuiteContribution
    const activation = {
      revision: 1,
      suite: { ownerPluginId: 'builtin.pylon-renderers', ownerRuntimeInstanceId: 'runtime', contributionId: 'builtin.solid', layer: 'feature', priority: 1, value: suite } as RegistryEntry<RendererSuiteContribution>,
      kinds: new Map(), slots: new Map([['message.assistant', [entry]]]), diagnostics: [],
    } as RendererActivationSnapshot
    mountSolidWorkbench({
      host, input: { sheetId: 'sheet-a', sessionId: 'preview-session' }, services, hostPort, activation,
    })

    fireEvent.click(await screen.findByRole('button', { name: 'copy through semantic port' }))

    await waitFor(() => expect(services.commands.calls).toContainEqual({
      command: 'copy', args: ['preview-session', 'semantic copy'],
    }))
  })
})
