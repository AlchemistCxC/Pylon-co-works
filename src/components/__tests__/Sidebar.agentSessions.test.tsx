// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import SessionsPanel from '../sidebar/SessionsPanel.tsx'
import Sidebar from '../Sidebar.tsx'
import { useWorkspaceStore } from '../../workspaceStore'
import { useIdentityStore } from '../../domains/identity/identityStore'
import { useWorkspaceEntityStore } from '../../workspaceEntityStore'
import { useSidebarContributionProps } from '../sidebar/useSidebarContributionProps.ts'
import { resetStores } from '../../test/resetStores'
import type { AgentSidebarContributionProps } from '../../plugin-runtime/sidebar/sidebarTypes.ts'
import type { WorkspaceSession } from '../../domains/session/workspaceSession.ts'

// 下沉自 scripts/test-agent-sidebar.mts（P91 A2）：面板运行点读 liveGeneratingSources、
// 会话交互保留、showPet toggle 写 workspaceStore（原为源码 token 断言）。

function session(overrides: Partial<WorkspaceSession> = {}): WorkspaceSession {
  return {
    id: 's1',
    agentId: 'peri',
    name: '会话一',
    source: 'src-1',
    profileId: 'default',
    createdAt: 1,
    lastActiveAt: 1,
    platform: 'pylon',
    workdir: 'G:/Pylon',
    sessionPrompt: '',
    skills: [],
    hooks: [],
    autoName: '',
    ...overrides,
  }
}

function panelProps(overrides: Partial<AgentSidebarContributionProps> = {}): AgentSidebarContributionProps {
  return {
    activeAgentId: 'peri',
    activeSessionId: null,
    sessions: [session()],
    workspaces: [],
    liveGeneratingSources: [],
    presentation: 'block' as const,
    collapsed: false,
    registerBlockActionHandler: vi.fn(),
    onBlockAction: vi.fn(),
    onSelectSession: vi.fn(),
    onDeleteSession: vi.fn(async () => {}),
    onOpenSessionSettings: vi.fn(),
    onRenameSession: vi.fn(),
    onCreateLooseSession: vi.fn(),
    onCreateWorkspace: vi.fn(async () => {}),
    onCreateWorkspaceSession: vi.fn(),
    ...overrides,
  }
}

describe('会话面板运行点（data-running 按 liveGeneratingSources）', () => {
  afterEach(async () => {
    const { cleanup } = await import('@testing-library/react')
    cleanup()
  })

  it('无 cwd 会话：source 在 live 列表 → 运行点亮；不在 → 无 data-running', () => {
    const { rerender } = render(<SessionsPanel {...panelProps({ liveGeneratingSources: ['src-1'] })} />)
    expect(document.querySelector('.session-dot')!.getAttribute('data-running')).toBe('true')

    rerender(<SessionsPanel {...panelProps({ liveGeneratingSources: [] })} />)
    expect(document.querySelector('.session-dot')!.hasAttribute('data-running')).toBe(false)
  })

  it('工作区会话：同样的运行点语义', () => {
    const workspace = {
      id: 'workspace-1',
      agentId: 'peri',
      name: 'Pylon',
      rootPath: 'G:/Project/Pylon',
      createdAt: 1,
      lastActiveAt: 1,
      skills: [],
      mcpServerIds: [],
      hookPluginIds: [],
    }
    const bound = session({ workspaceId: 'workspace-1' })
    const { rerender } = render(
      <SessionsPanel {...panelProps({ workspaces: [workspace], sessions: [bound], liveGeneratingSources: ['src-1'] })} />,
    )
    expect(document.querySelector('.session-dot')!.getAttribute('data-running')).toBe('true')

    rerender(
      <SessionsPanel {...panelProps({ workspaces: [workspace], sessions: [bound], liveGeneratingSources: ['other'] })} />,
    )
    expect(document.querySelector('.session-dot')!.hasAttribute('data-running')).toBe(false)
  })
})

describe('会话交互保留', () => {
  afterEach(async () => {
    const { cleanup } = await import('@testing-library/react')
    cleanup()
  })

  it('设置回调携带会话 id；删除按钮已从行上撤出（收进设置）', () => {
    const onOpenSessionSettings = vi.fn()
    render(<SessionsPanel {...panelProps({ onOpenSessionSettings })} />)

    fireEvent.click(screen.getByRole('button', { name: '会话一 会话设置' }))
    expect(onOpenSessionSettings).toHaveBeenCalledWith('s1')
    expect(screen.queryByRole('button', { name: '删除 会话一' })).toBeNull()
  })

  it('置顶的会话排在所属工作区最前（即使它更久没活跃）', () => {
    // 排序在 props 接线处（置顶优先 → 最近活跃），因此直接对那只钩子下断言：
    // 走 Sidebar 反而要先把会话模块注册进插件注册表，测到的是别的东西。
    const workspace = { id: 'w1', agentId: 'peri', name: 'Pylon', rootPath: 'G:/Pylon', createdAt: 1, lastActiveAt: 1, skills: [], mcpServerIds: [], hookPluginIds: [] }
    useIdentityStore.setState({
      activeAgent: 'peri',
      activeProfileId: 'default',
      profiles: [{ id: 'default', name: 'Default', persona: '', model: '' }],
      sessions: [
        { ...session({ id: 's-new', name: '最近活跃', workspaceId: 'w1' }), lastActiveAt: 900 },
        { ...session({ id: 's-pin', name: '置顶的', workspaceId: 'w1', pinned: true }), lastActiveAt: 100 },
      ] as never,
    })
    useWorkspaceEntityStore.setState({ workspaces: [workspace] as never })
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
    }
    const Probe = () => {
      const props = useSidebarContributionProps(ctx as never)
      return <div data-testid="order">{props.sessions.map(item => item.name).join(',')}</div>
    }
    render(<Probe />)
    expect(screen.getByTestId('order').textContent).toBe('置顶的,最近活跃')
  })

  it('双击进入重命名，Enter 提交回调', () => {
    const onRenameSession = vi.fn()
    render(<SessionsPanel {...panelProps({ onRenameSession })} />)
    fireEvent.doubleClick(screen.getByText('会话一'))
    const input = screen.getByDisplayValue('会话一') as HTMLInputElement
    fireEvent.change(input, { target: { value: '新名字' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onRenameSession).toHaveBeenCalledWith('s1', '新名字')
  })
})

describe('showPet toggle 写 workspaceStore', () => {
  afterEach(async () => {
    const { cleanup } = await import('@testing-library/react')
    cleanup()
  })

  it('点击宠物切换写 store 且 aria-pressed 反映，AgentSheet 消费同源', () => {
    localStorage.clear()
    resetStores()
    useIdentityStore.setState({
      activeAgent: 'peri',
      activeProfileId: 'default',
      profiles: [{ id: 'default', name: 'Default', persona: '', model: '' }],
      sessions: [],
    })
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
    }
    useWorkspaceStore.setState({ showPet: false })
    render(<Sidebar ctx={ctx as never} />)
    const toggle = screen.getByTitle('显示宠物')
    expect(toggle.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(toggle)
    expect(useWorkspaceStore.getState().showPet).toBe(true)
    expect(toggle.getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByTitle('隐藏宠物').getAttribute('aria-pressed')).toBe('true')
  })
})
