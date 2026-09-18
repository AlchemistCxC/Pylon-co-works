// @vitest-environment jsdom
import { fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Sidebar from '../Sidebar'
import { useBlockActionHandler } from '../sidebar/useBlockActionHandler.ts'
import { resetStores } from '../../test/resetStores'
import { useIdentityStore } from '../../identityStore'
import { useWorkspaceStore } from '../../workspaceStore'
import type { SheetContext } from '../../workspace-sheets/sheetTypes'
import { getAgentSidebarRegistry } from '../../plugin-runtime/runtimeServices.ts'
import { createPluginIdentity } from '../../plugin-runtime/pluginIdentity.ts'
import type {
  AgentSidebarContribution,
  AgentSidebarContributionProps,
  AgentSidebarRegion,
} from '../../plugin-runtime/sidebar/sidebarTypes.ts'

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

function register(contribution: Partial<AgentSidebarContribution> & { id: string; region: AgentSidebarRegion }) {
  const registry = getAgentSidebarRegistry()
  identitySeq += 1
  const identity = createPluginIdentity('test.sidebar-blocks', `run-${identitySeq}`)
  disposals.push(registry.register(identity, {
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

/** 用真实 hook 注册区块头处理器——被测的正是「宿主渲染头部、语义由贡献注册」这条链路。 */
function ActionProbe({ registerBlockActionHandler }: Pick<AgentSidebarContributionProps, 'registerBlockActionHandler'>) {
  useBlockActionHandler({ registerBlockActionHandler }, actionId => { receivedAction = actionId })
  return <Body name="probe" />
}

beforeEach(() => {
  localStorage.clear()
  resetStores()
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

describe('左栏区块栈模型', () => {
  it('两个分区按 modules → sessions 纵向堆叠，区块按 order 排、标题取自贡献的 label', () => {
    register({ id: 'mod-late', region: 'modules', label: '自动化', order: 200, component: () => <Body name="late" /> })
    register({ id: 'mod-early', region: 'modules', label: '定时', order: 100, component: () => <Body name="early" /> })
    register({ id: 'sessions', region: 'sessions', label: '会话', order: 100, component: () => <Body name="sessions" /> })

    render(<Sidebar ctx={ctx} />)

    const regions = [...document.querySelectorAll('.sidebar-region')]
    expect(regions.map(node => node.getAttribute('data-region'))).toEqual(['modules', 'sessions'])

    const moduleTitles = [...regions[0].querySelectorAll('.sidebar-block-title')].map(node => node.textContent)
    expect(moduleTitles).toEqual(['定时', '自动化'])

    // 标题由宿主从 `label` 渲染，贡献组件不再画第二份标题。
    const sessionBlock = regions[1].querySelector('.sidebar-block')!
    expect(within(sessionBlock as HTMLElement).getByText('会话')).toHaveClass('sidebar-block-title')
  })

  it('搜索框归会话区；模块区没有搜索框', () => {
    register({ id: 'mod', region: 'modules', label: '定时', component: () => <Body name="mod" /> })
    register({ id: 'sessions', region: 'sessions', label: '会话', component: () => <Body name="sessions" /> })
    render(<Sidebar ctx={ctx} />)

    const regions = [...document.querySelectorAll('.sidebar-region')]
    expect(regions[0].querySelector('.search-input')).toBeNull()
    expect(regions[1].querySelector('.search-input')).not.toBeNull()
    expect(screen.getByPlaceholderText('搜索会话...')).toBeInTheDocument()
  })

  it('when 为假时区块整体不渲染', () => {
    register({ id: 'gated', region: 'modules', label: '自动化', when: () => false, component: () => <Body name="gated" /> })
    register({ id: 'shown', region: 'modules', label: '定时', when: () => true, component: () => <Body name="shown" /> })
    render(<Sidebar ctx={ctx} />)

    expect(screen.queryByText('自动化')).toBeNull()
    expect(screen.getByText('定时')).toBeInTheDocument()
  })

  it('折叠：modules 默认可折叠，折叠后不渲染 body，切换写回 sheet state', () => {
    const patchSheetState = vi.fn()
    useWorkspaceStore.setState({ patchSheetState })
    register({ id: 'mod', region: 'modules', label: '定时', component: () => <Body name="mod" /> })

    const view = render(<Sidebar ctx={ctx} sheet={{ id: SHEET_ID }} state={{ blockCollapsed: {} }} />)
    const block = document.querySelector('.sidebar-block[data-contribution-id="mod"]') as HTMLElement
    expect(block).toHaveAttribute('data-collapsed', 'false')
    expect(screen.getByTestId('body-mod')).toBeInTheDocument()

    // 未声明 page 的区块：标题按钮退化为折叠开关；折叠钮是独立按钮。
    fireEvent.click(within(block).getByRole('button', { name: '定时' }))
    expect(patchSheetState).toHaveBeenCalledWith(SHEET_ID, { blockCollapsed: { mod: true }, activePageId: null })

    // 状态回流后 body 不再挂载。
    view.rerender(<Sidebar ctx={ctx} sheet={{ id: SHEET_ID }} state={{ blockCollapsed: { mod: true } }} />)
    expect(document.querySelector('.sidebar-block[data-contribution-id="mod"]')).toHaveAttribute('data-collapsed', 'true')
    expect(screen.queryByTestId('body-mod')).toBeNull()
  })

  it('独立的折叠钮按 collapsible 渲染；不可折叠区块没有折叠控件', () => {
    register({ id: 'mod', region: 'modules', label: '定时', component: () => <Body name="mod" /> })
    register({ id: 'sessions', region: 'sessions', label: '会话', component: () => <Body name="sessions" /> })
    render(<Sidebar ctx={ctx} sheet={{ id: SHEET_ID }} />)

    expect(screen.getByRole('button', { name: '折叠 定时' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /折叠 会话|展开 会话/ })).toBeNull()
    // 不可折叠且无页面的区块：标题不渲染成按钮（点它无处可去）。
    const sessionsTitle = document.querySelector('.sidebar-block[data-contribution-id="sessions"] .sidebar-block-title')!
    expect(sessionsTitle.closest('button')).toBeNull()
  })

  it('声明 page 的区块：点标题打开整页并把 activePageId 落库，标题不再管折叠', () => {
    const patchSheetState = vi.fn()
    useWorkspaceStore.setState({ patchSheetState })
    register({ id: 'scheduled', region: 'modules', label: '定时', page: { title: '定时' }, component: () => <Body name="scheduled" /> })

    render(<Sidebar ctx={ctx} sheet={{ id: SHEET_ID }} state={{ blockCollapsed: {} }} />)
    fireEvent.click(screen.getByRole('button', { name: '定时' }))
    expect(patchSheetState).toHaveBeenCalledWith(SHEET_ID, { blockCollapsed: {}, activePageId: 'scheduled' })
  })

  it('已展开成整页的区块在左栏标记 data-page-open，便于与主区对上', () => {
    register({ id: 'scheduled', region: 'modules', label: '定时', page: { title: '定时' }, component: () => <Body name="scheduled" /> })
    render(<Sidebar ctx={ctx} sheet={{ id: SHEET_ID }} state={{ blockCollapsed: {}, activePageId: 'scheduled' }} />)

    expect(document.querySelector('.sidebar-block[data-contribution-id="scheduled"]')).toHaveAttribute('data-page-open', 'true')
  })

  it('损坏／旧模型的持久化状态回落为空映射：区块全部展开，不抛错', () => {
    register({ id: 'mod', region: 'modules', label: '定时', component: () => <Body name="mod" /> })
    // `{ sidebarMode: 'chat' }` 是旧模型的落盘形状；`blockCollapsed` 类型不对也一并覆盖。
    render(<Sidebar ctx={ctx} sheet={{ id: SHEET_ID }} state={{ sidebarMode: 'chat', blockCollapsed: 'nope' }} />)

    expect(document.querySelector('.sidebar-block[data-contribution-id="mod"]')).toHaveAttribute('data-collapsed', 'false')
    expect(screen.getByTestId('body-mod')).toBeInTheDocument()
  })

  it('区块头动作由宿主渲染，点击经注册处理器回派给贡献', () => {
    receivedAction = null
    register({
      id: 'mod',
      region: 'modules',
      label: '定时',
      headerActions: [{ id: 'new-workspace', label: '工作区', icon: 'plus' }],
      component: ActionProbe,
    })
    render(<Sidebar ctx={ctx} sheet={{ id: SHEET_ID }} />)

    fireEvent.click(screen.getByRole('button', { name: '工作区' }))
    expect(receivedAction).toBe('new-workspace')
  })
})
