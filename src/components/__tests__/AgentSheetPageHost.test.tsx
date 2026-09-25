// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AgentSheetPageHost, { useOpenSidebarPage } from '../sidebar/AgentSheetPageHost.tsx'
import { resetStores } from '../../test/resetStores'
import { useIdentityStore } from '../../domains/identity/identityStore'
import { useWorkspaceStore } from '../../workspaceStore'
import type { SheetContext } from '../../workspace-sheets/sheetTypes'
import { getAgentSidebarRegistry } from '../../plugin-runtime/runtimeServices.ts'
import { createPluginIdentity } from '../../plugin-runtime/pluginIdentity.ts'
import type { AgentSidebarContribution, AgentSidebarContributionProps } from '../../plugin-runtime/sidebar/sidebarTypes.ts'

const ctx = {
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
} as SheetContext

const SHEET_ID = 'sheet-page'

let identitySeq = 0
const disposals: Array<{ dispose(): void | Promise<void> }> = []

function register(contribution: Partial<AgentSidebarContribution> & { id: string }) {
  const registry = getAgentSidebarRegistry()
  identitySeq += 1
  disposals.push(registry.register(createPluginIdentity('test.page-host', `run-${identitySeq}`), {
    label: contribution.id,
    renderKind: 'first-party-react',
    component: () => null,
    ...contribution,
  } as AgentSidebarContribution))
}

/** 观察贡献拿到的 presentation——「区块小样 / 主区整页」是同一组件两种体量。 */
function PresentationProbe(props: Partial<AgentSidebarContributionProps>) {
  return <div data-testid="probe">{props.presentation}</div>
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

describe('AgentSheet 主区整页宿主', () => {
  it('渲染页面标题与内容，并以 presentation=page 交给同一个贡献组件', () => {
    register({ id: 'scheduled', label: '定时', page: { title: '定时任务' }, component: PresentationProbe })
    render(<AgentSheetPageHost page={getAgentSidebarRegistry().list()[0]} ctx={ctx} sheet={{ id: SHEET_ID }} />)

    expect(screen.getByRole('heading', { name: '定时任务' })).toBeInTheDocument()
    expect(screen.getByTestId('probe')).toHaveTextContent('page')
  })

  it('「返回」只清整页状态（折叠已迁出为全局偏好，与 Sheet 级整页互不牵挂，issue #202）', () => {
    const patchSheetState = vi.fn()
    useWorkspaceStore.setState({ patchSheetState })
    register({ id: 'scheduled', label: '定时', page: { title: '定时任务' }, component: PresentationProbe })
    render(<AgentSheetPageHost page={getAgentSidebarRegistry().list()[0]} ctx={ctx} sheet={{ id: SHEET_ID }} />)

    fireEvent.click(screen.getByRole('button', { name: '返回聊天' }))
    expect(patchSheetState).toHaveBeenCalledWith(SHEET_ID, { activePageId: null })
  })

  it('Esc 也能关闭整页（键盘用户的退路）', () => {
    const patchSheetState = vi.fn()
    useWorkspaceStore.setState({ patchSheetState })
    register({ id: 'scheduled', label: '定时', page: { title: '定时任务' }, component: PresentationProbe })
    render(<AgentSheetPageHost page={getAgentSidebarRegistry().list()[0]} ctx={ctx} sheet={{ id: SHEET_ID }} />)

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(patchSheetState).toHaveBeenCalledWith(SHEET_ID, { activePageId: null })
  })

  it('没有 page 声明的贡献即使被 activePageId 指到也解不出来（不渲染任何页面）', () => {
    register({ id: 'tasks', label: '任务', component: PresentationProbe })
    const state = { activePageId: 'tasks' }

    function Probe() {
      const page = useOpenSidebarPage(state)
      return <div data-testid="resolved">{page ? page.id : 'none'}</div>
    }
    render(<Probe />)
    expect(screen.getByTestId('resolved')).toHaveTextContent('none')
  })

  it('activePageId 指向已卸载的贡献时回落 null（插件停用不锁死主区）', () => {
    const state = { activePageId: 'gone' }
    function Probe() {
      const page = useOpenSidebarPage(state)
      return <div data-testid="resolved">{page ? page.id : 'none'}</div>
    }
    render(<Probe />)
    expect(screen.getByTestId('resolved')).toHaveTextContent('none')
  })
})
