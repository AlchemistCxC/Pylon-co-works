// @vitest-environment jsdom
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Sidebar from '../Sidebar'
import { useBlockActionHandler } from '../sidebar/useBlockActionHandler.ts'
import { resetStores } from '../../test/resetStores'
import { useIdentityStore } from '../../identityStore'
import { resetModulePrefs, SIDEBAR_MODULES_STORAGE_KEY } from '../../domains/workbench/sidebarModulePrefs.ts'
import { resetBlockCollapse, SIDEBAR_BLOCK_COLLAPSE_STORAGE_KEY } from '../../domains/workbench/sidebarBlockCollapse.ts'
import { resolveOpenPage } from '../../plugin-runtime/sidebar/sidebarBlockState.ts'
import type { SheetContext } from '../../workspace-sheets/sheetTypes'
import { getAgentSidebarRegistry } from '../../plugin-runtime/runtimeServices.ts'
import { createPluginIdentity } from '../../plugin-runtime/pluginIdentity.ts'
import type { AgentSidebarContribution, AgentSidebarContributionProps } from '../../plugin-runtime/sidebar/sidebarTypes.ts'

const ctx: SheetContext = {
  openSheet: () => null,
  focusSheet: () => {},
  closeSheet: () => {},
  activeSession: null,
  selectSession: () => {},
  openProfileEdit: () => {},
  openSessionSettings: () => {},
  sidebarCollapsed: false,
  rightInset: 0,
  ccEditMode: false,
  sessionSource: () => null,
  sessionBySource: () => undefined,
}

const SHEET_ID = 'sheet-blocks'

let identitySeq = 0
const disposals: Array<{ dispose(): void | Promise<void> }> = []

function register(contribution: Partial<AgentSidebarContribution> & { id: string }) {
  const registry = getAgentSidebarRegistry()
  identitySeq += 1
  disposals.push(registry.register(createPluginIdentity('test.sidebar-blocks', `run-${identitySeq}`), {
    label: contribution.id,
    renderKind: 'first-party-react',
    component: () => null,
    ...contribution,
  } as AgentSidebarContribution))
}

function Body({ name }: { name: string }) {
  return <div data-testid={`body-${name}`}>{name} 内容</div>
}

let receivedAction: string | null = null

function ActionProbe({ registerBlockActionHandler }: Pick<AgentSidebarContributionProps, 'registerBlockActionHandler'>) {
  useBlockActionHandler({ registerBlockActionHandler }, actionId => { receivedAction = actionId })
  return <Body name="probe" />
}

const moduleIds = () => [...document.querySelectorAll('.sidebar-block')].map(node => node.getAttribute('data-module-id'))
const blockOf = (id: string) => document.querySelector(`.sidebar-block[data-module-id="${id}"]`) as HTMLElement

beforeEach(() => {
  localStorage.clear()
  resetStores()
  resetModulePrefs()
  resetBlockCollapse()
  receivedAction = null
  useIdentityStore.setState({
    activeAgent: 'peri',
    activeProfileId: 'default',
    profiles: [{ id: 'default', name: 'Default', persona: '', model: '' }],
    sessions: [],
  })
})

afterEach(() => {
  while (disposals.length > 0) void disposals.pop()!.dispose()
})

describe('左栏模块栈模型', () => {
  it('模块是一维有序栈，次序由 order 决定，标题取自贡献的 label', () => {
    register({ id: 'mod-late', label: '自动化', order: 200, component: () => <Body name="late" /> })
    register({ id: 'mod-early', label: '定时', order: 100, component: () => <Body name="early" /> })
    register({ id: 'mod-sessions', label: '会话', order: 900, alwaysOpen: true, component: () => <Body name="sessions" /> })

    render(<Sidebar ctx={ctx} />)

    expect(moduleIds()).toEqual(['mod-early', 'mod-late', 'mod-sessions'])
    expect([...document.querySelectorAll('.sidebar-block-title')].map(node => node.textContent))
      .toEqual(['定时', '自动化', '会话'])
  })

  it('图标按稳定键渲染；未知键安全降级', () => {
    register({ id: 'mod', label: '定时', icon: 'clock', component: () => <Body name="mod" /> })
    render(<Sidebar ctx={ctx} />)
    expect(blockOf('mod').querySelector('.sidebar-block-icon')).not.toBeNull()
  })

  it('when 为假时模块整体不渲染', () => {
    register({ id: 'gated', label: '自动化', when: () => false, component: () => <Body name="gated" /> })
    register({ id: 'shown', label: '定时', when: () => true, component: () => <Body name="shown" /> })
    render(<Sidebar ctx={ctx} />)

    expect(screen.queryByText('自动化')).toBeNull()
    expect(screen.getByText('定时')).toBeInTheDocument()
  })

  it('标题点击展开/折叠（默认语义）：折叠后 body 仍挂载但被 inert 且零高，状态写入全局折叠偏好', () => {
    register({ id: 'mod', label: '定时', component: () => <Body name="mod" /> })

    render(<Sidebar ctx={ctx} sheet={{ id: SHEET_ID }} />)
    expect(blockOf('mod')).toHaveAttribute('data-collapsed', 'false')
    fireEvent.click(within(blockOf('mod')).getByRole('button', { name: '定时' }))
    // 折叠经全局 store 落**独立持久化 key**（跨 Sheet 共享，issue #202）；UI 由 store 订阅刷新，
    // 不再依赖 sheet 状态回灌。
    expect(blockOf('mod')).toHaveAttribute('data-collapsed', 'true')
    expect(JSON.parse(localStorage.getItem(SIDEBAR_BLOCK_COLLAPSE_STORAGE_KEY)!).collapsed).toEqual({ mod: true })

    // body **不再卸载**：折叠是 CSS 把行高收到 0（有过渡），因此这里断言「挂载但不可交互」。
    const body = blockOf('mod').querySelector('.sidebar-block-body') as HTMLElement
    expect(body).not.toBeNull()
    expect(body).toHaveAttribute('inert')
    expect(screen.getByTestId('body-mod')).toBeInTheDocument()

    // 再点一次展开：显式条目翻转回 false，而不是删掉条目回落默认。
    fireEvent.click(within(blockOf('mod')).getByRole('button', { name: '定时' }))
    expect(blockOf('mod')).toHaveAttribute('data-collapsed', 'false')
    expect(JSON.parse(localStorage.getItem(SIDEBAR_BLOCK_COLLAPSE_STORAGE_KEY)!).collapsed).toEqual({ mod: false })
  })

  it('折叠是跨 Sheet 的应用级偏好：Sheet A 折叠后，Sheet B 的左栏同态（issue #202）', () => {
    register({ id: 'mod', label: '定时', component: () => <Body name="mod" /> })

    const view = render(<Sidebar ctx={ctx} sheet={{ id: 'sheet-a' }} />)
    fireEvent.click(within(blockOf('mod')).getByRole('button', { name: '定时' }))
    expect(blockOf('mod')).toHaveAttribute('data-collapsed', 'true')

    // 换一张 Sheet 渲染左栏：读的是同一份全局映射，折叠不随切换改变。
    view.rerender(<Sidebar ctx={ctx} sheet={{ id: 'sheet-b' }} />)
    expect(blockOf('mod')).toHaveAttribute('data-collapsed', 'true')
  })

  it('展开态 body 不 inert（折叠是过渡而不是卸载，交互门控靠 inert）', () => {
    register({ id: 'mod', label: '定时', component: () => <Body name="mod" /> })
    render(<Sidebar ctx={ctx} sheet={{ id: SHEET_ID }} />)
    const body = blockOf('mod').querySelector('.sidebar-block-body') as HTMLElement
    expect(body).not.toBeNull()
    expect(body).not.toHaveAttribute('inert')
  })

  it('alwaysOpen 的模块**也可折叠**（常驻只表示不可隐藏），默认展开', () => {
    register({ id: 'sessions', label: '会话', alwaysOpen: true, component: () => <Body name="sessions" /> })
    render(<Sidebar ctx={ctx} sheet={{ id: SHEET_ID }} />)
    // 默认展开（alwaysOpen 只是默认不折叠，用户折叠过则尊重用户）
    expect(blockOf('sessions')).toHaveAttribute('data-collapsed', 'false')

    // 用户显式折叠过则以用户为准（全局折叠偏好，跨 Sheet 生效）。store 写入发生在 React
    // 事件之外，需要 act 让 useSyncExternalStore 的重渲染落地。
    act(() => { resetBlockCollapse({ sessions: true }) })
    expect(blockOf('sessions')).toHaveAttribute('data-collapsed', 'true')

    act(() => { resetBlockCollapse() })
    fireEvent.click(within(blockOf('sessions')).getByRole('button', { name: '会话' }))
    expect(JSON.parse(localStorage.getItem(SIDEBAR_BLOCK_COLLAPSE_STORAGE_KEY)!).collapsed).toEqual({ sessions: true })
  })

  it('「都要」：声明 page 且标题语义为 expand 时，标题折叠 + 头部自动出现「打开」', () => {
    register({ id: 'scheduled', label: '定时', page: { title: '定时' }, component: () => <Body name="scheduled" /> })
    render(<Sidebar ctx={ctx} sheet={{ id: SHEET_ID }} />)

    expect(blockOf('scheduled')).toHaveAttribute('data-collapsed', 'false')
    expect(screen.getByRole('button', { name: '打开 定时 页面' })).toBeInTheDocument()
  })

  it('onTitleClick=page：标题进入整页，折叠改由独立折叠钮负责', () => {
    register({ id: 'automation', label: '自动化', onTitleClick: 'page', page: { title: '自动化' }, component: () => <Body name="automation" /> })
    render(<Sidebar ctx={ctx} sheet={{ id: SHEET_ID }} />)

    expect(within(blockOf('automation')).getByRole('button', { name: '自动化' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '折叠 自动化' })).toBeInTheDocument()
    // 标题已负责进页面，head 不再重复一个「打开」
    expect(screen.queryByRole('button', { name: '打开 自动化 页面' })).toBeNull()
  })

  it('头部动作由宿主渲染，点击经注册处理器回派给贡献', () => {
    register({
      id: 'mod',
      label: '定时',
      headerActions: [{ id: 'new-workspace', label: '工作区', icon: 'plus' }],
      component: ActionProbe,
    })
    render(<Sidebar ctx={ctx} sheet={{ id: SHEET_ID }} />)

    fireEvent.click(screen.getByRole('button', { name: '工作区' }))
    expect(receivedAction).toBe('new-workspace')
  })

  it('显隐偏好：被隐藏的模块不出现在栈里，alwaysOpen 的模块不受隐藏影响', () => {
    register({ id: 'mod', label: '定时', component: () => <Body name="mod" /> })
    register({ id: 'sessions', label: '会话', alwaysOpen: true, component: () => <Body name="sessions" /> })
    localStorage.setItem(SIDEBAR_MODULES_STORAGE_KEY, JSON.stringify({ order: [], hidden: ['mod', 'sessions'] }))
    resetModulePrefs({ order: [], hidden: ['mod', 'sessions'] })

    render(<Sidebar ctx={ctx} />)
    expect(moduleIds()).toEqual(['sessions'])
  })

  it('长按模块头进入拖拽，抬起后把新次序落库（没有独立手柄）', () => {
    vi.useFakeTimers()
    try {
      register({ id: 'a', label: '定时', order: 100, component: () => <Body name="a" /> })
      register({ id: 'b', label: '自动化', order: 200, component: () => <Body name="b" /> })
      render(<Sidebar ctx={ctx} sheet={{ id: SHEET_ID }} />)
      expect(moduleIds()).toEqual(['a', 'b'])

      const head = blockOf('a').querySelector('.sidebar-block-head') as HTMLElement
      fireEvent.pointerDown(head, { pointerId: 1, button: 0, clientX: 12, clientY: 10 })
      // 还没到长按时长：不动。移动超过阈值则取消（点击/滚动，不是拖拽）。
      act(() => { vi.advanceTimersByTime(200) })
      expect(blockOf('a')).toHaveAttribute('data-dragging', 'false')

      act(() => { vi.advanceTimersByTime(200) })
      expect(blockOf('a')).toHaveAttribute('data-dragging', 'true')

      fireEvent.pointerMove(head, { pointerId: 1, clientY: 10_000 })
      fireEvent.pointerUp(head, { pointerId: 1, clientY: 10_000 })

      expect(JSON.parse(localStorage.getItem(SIDEBAR_MODULES_STORAGE_KEY)!).order).toEqual(['b', 'a'])
      expect(blockOf('a')).toHaveAttribute('data-dragging', 'false')
    } finally {
      vi.useRealTimers()
    }
  })

  it('常驻模块固定栈底：长按它不进拖拽，别的模块也落不到它下面', () => {
    vi.useFakeTimers()
    try {
      register({ id: 'a', label: '定时', order: 100, component: () => <Body name="a" /> })
      register({ id: 'b', label: '自动化', order: 200, component: () => <Body name="b" /> })
      register({ id: 'sessions', label: '会话', alwaysOpen: true, order: 900, component: () => <Body name="s" /> })
      render(<Sidebar ctx={ctx} sheet={{ id: SHEET_ID }} />)
      expect(moduleIds()).toEqual(['a', 'b', 'sessions'])

      // ① 长按常驻模块头：不进拖拽（它能去哪儿？钉区之上的位置对会话没有意义）。
      const pinnedHead = blockOf('sessions').querySelector('.sidebar-block-head') as HTMLElement
      fireEvent.pointerDown(pinnedHead, { pointerId: 1, button: 0, clientX: 12, clientY: 10 })
      act(() => { vi.advanceTimersByTime(400) })
      expect(blockOf('sessions')).toHaveAttribute('data-dragging', 'false')
      expect(blockOf('sessions').querySelector('.sidebar-block-head')).toHaveAttribute('title', '常驻模块固定在栈底')
      fireEvent.pointerUp(pinnedHead, { pointerId: 1 })

      // ② 拖动 a 到最底：落点被钳在钉区之前，次序仍是 [b, a, sessions]。
      const head = blockOf('a').querySelector('.sidebar-block-head') as HTMLElement
      fireEvent.pointerDown(head, { pointerId: 2, button: 0, clientX: 12, clientY: 10 })
      act(() => { vi.advanceTimersByTime(400) })
      fireEvent.pointerMove(head, { pointerId: 2, clientY: 10_000 })
      fireEvent.pointerUp(head, { pointerId: 2, clientY: 10_000 })

      expect(moduleIds()).toEqual(['b', 'a', 'sessions'])
      // 落库的次序里常驻模块**仍在最后**——落点被钳住，用户写不出「谁在会话下面」这种次序。
      expect(JSON.parse(localStorage.getItem(SIDEBAR_MODULES_STORAGE_KEY)!).order).toEqual(['b', 'a', 'sessions'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('长按期间一旦移动超过阈值即取消（不把点击/滚动误判成拖拽）', () => {
    vi.useFakeTimers()
    try {
      register({ id: 'a', label: '定时', component: () => <Body name="a" /> })
      register({ id: 'b', label: '自动化', component: () => <Body name="b" /> })
      render(<Sidebar ctx={ctx} sheet={{ id: SHEET_ID }} />)

      const head = blockOf('a').querySelector('.sidebar-block-head') as HTMLElement
      fireEvent.pointerDown(head, { pointerId: 1, button: 0, clientX: 12, clientY: 10 })
      fireEvent.pointerMove(head, { pointerId: 1, clientX: 40, clientY: 10 })
      act(() => { vi.advanceTimersByTime(400) })

      expect(blockOf('a')).toHaveAttribute('data-dragging', 'false')
      fireEvent.pointerUp(head, { pointerId: 1 })
      // 没有落库任何次序（beforeEach 写入的是空偏好）。
      expect(JSON.parse(localStorage.getItem(SIDEBAR_MODULES_STORAGE_KEY)!).order).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  /**
   * 回归：捕获时机。
   *
   * Chromium 的 `click` 派发在「按下目标」与「抬起目标的**最近公共祖先**」上；在按下时就捕获
   * 指针会把抬起目标改写成捕获元素（模块头），于是头内部的按钮全部收不到 click——「左栏所有
   * 按钮点了没反应」就是这么来的（实机实测：click@.sidebar-block-head）。
   *
   * jsdom 不实现指针捕获，改派本身复现不出来，所以这里断言的是**捕获发生在何时**：按下不捕获、
   * 长按到点才捕获。这条断言在旧实现（按下即捕获）下会红。
   */
  it('按下模块头不捕获指针，长按到点进入拖拽才捕获（否则头内部按钮的 click 会被改派走）', () => {
    const original = Object.getOwnPropertyDescriptor(Element.prototype, 'setPointerCapture')
    const captured: Array<{ target: unknown; pointerId: number }> = []
    Object.defineProperty(Element.prototype, 'setPointerCapture', {
      configurable: true,
      writable: true,
      value(this: Element, pointerId: number) { captured.push({ target: this, pointerId }) },
    })
    vi.useFakeTimers()
    try {
      register({ id: 'a', label: '定时', component: () => <Body name="a" /> })
      render(<Sidebar ctx={ctx} sheet={{ id: SHEET_ID }} />)

      const block = blockOf('a')
      const head = block.querySelector('.sidebar-block-head') as HTMLElement
      const toggle = block.querySelector('.sidebar-block-toggle') as HTMLElement

      fireEvent.pointerDown(toggle, { pointerId: 7, button: 0, clientX: 12, clientY: 10 })
      expect(captured).toEqual([])

      act(() => { vi.advanceTimersByTime(300) })
      expect(captured).toEqual([{ target: head, pointerId: 7 }])
      expect(block).toHaveAttribute('data-dragging', 'true')
      fireEvent.pointerUp(head, { pointerId: 7 })
    } finally {
      vi.useRealTimers()
      if (original) Object.defineProperty(Element.prototype, 'setPointerCapture', original)
      else delete (Element.prototype as unknown as Record<string, unknown>).setPointerCapture
    }
  })

  it('按下后指针离开模块头即取消长按（无捕获时外部移动收不到，拖拽会误触发）', () => {
    const original = Object.getOwnPropertyDescriptor(Element.prototype, 'setPointerCapture')
    Object.defineProperty(Element.prototype, 'setPointerCapture', { configurable: true, writable: true, value: () => {} })
    vi.useFakeTimers()
    try {
      register({ id: 'a', label: '定时', component: () => <Body name="a" /> })
      render(<Sidebar ctx={ctx} sheet={{ id: SHEET_ID }} />)

      const block = blockOf('a')
      const head = block.querySelector('.sidebar-block-head') as HTMLElement
      fireEvent.pointerDown(head, { pointerId: 1, button: 0, clientX: 12, clientY: 10 })
      fireEvent.pointerLeave(head, { pointerId: 1, clientX: 12, clientY: 200 })
      act(() => { vi.advanceTimersByTime(400) })

      expect(block).toHaveAttribute('data-dragging', 'false')
      fireEvent.pointerUp(head, { pointerId: 1 })
    } finally {
      vi.useRealTimers()
      if (original) Object.defineProperty(Element.prototype, 'setPointerCapture', original)
      else delete (Element.prototype as unknown as Record<string, unknown>).setPointerCapture
    }
  })

  it('损坏／旧模型的持久化状态回落为空：模块全部展开，不抛错', () => {
    register({ id: 'mod', label: '定时', component: () => <Body name="mod" /> })
    render(<Sidebar ctx={ctx} sheet={{ id: SHEET_ID }} state={{ sidebarMode: 'chat', blockCollapsed: 'nope' }} />)

    expect(blockOf('mod')).toHaveAttribute('data-collapsed', 'false')
    expect(screen.getByTestId('body-mod')).toBeInTheDocument()
  })

  it('插件路径：isolated-surface 模块与页面都走同一条注册表，第三方无需宿主特例', () => {
    const registry = getAgentSidebarRegistry()
    identitySeq += 1
    disposals.push(registry.register(
      createPluginIdentity('test.third-party', `run-${identitySeq}`),
      {
        id: 'example.ops',
        label: 'Ops',
        icon: 'activity',
        order: 500,
        onTitleClick: 'page',
        page: { title: 'Ops 面板' },
        renderKind: 'isolated-surface',
        surfaceId: 'example.ops.surface',
      },
    ))

    render(<Sidebar ctx={ctx} />)
    // 与内置模块同一条栈、同一套外壳（图标/标题/折叠钮都由宿主画）。
    expect(moduleIds()).toContain('example.ops')
    expect(blockOf('example.ops').querySelector('.sidebar-block-icon')).not.toBeNull()
    expect(screen.getByRole('button', { name: '折叠 Ops' })).toBeInTheDocument()

    // 页面可被解析：同一贡献、同一 page 声明，主区宿主据此接管聊天视图。
    const resolved = resolveOpenPage(registry.list(), { activePageId: 'example.ops' })
    expect(resolved?.id).toBe('example.ops')
    expect(resolved?.page?.title).toBe('Ops 面板')
  })
})
