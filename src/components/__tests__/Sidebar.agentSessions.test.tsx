// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ChatSessionsPanel from '../sidebar/ChatSessionsPanel.tsx'
import WorkspacesPanel from '../sidebar/WorkspacesPanel.tsx'
import Sidebar from '../Sidebar.tsx'
import { useWorkspaceStore } from '../../workspaceStore'
import { useIdentityStore } from '../../identityStore'
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
    query: '',
    activeSessionId: null,
    sessions: [session()],
    workspaces: [],
    liveGeneratingSources: [],
    onSelectSession: vi.fn(),
    onDeleteSession: vi.fn(async () => {}),
    onOpenSessionSettings: vi.fn(),
    onRenameSession: vi.fn(),
    onCreateChatSession: vi.fn(),
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

  it('聊天面板：source 在 live 列表 → 运行点亮；不在 → 无 data-running', () => {
    const { rerender } = render(<ChatSessionsPanel {...panelProps({ liveGeneratingSources: ['src-1'] })} />)
    expect(document.querySelector('.session-dot')!.getAttribute('data-running')).toBe('true')

    rerender(<ChatSessionsPanel {...panelProps({ liveGeneratingSources: [] })} />)
    expect(document.querySelector('.session-dot')!.hasAttribute('data-running')).toBe(false)
  })

  it('工作面板：同样的运行点语义', () => {
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
      <WorkspacesPanel {...panelProps({ workspaces: [workspace], sessions: [bound], liveGeneratingSources: ['src-1'] })} />,
    )
    expect(document.querySelector('.session-dot')!.getAttribute('data-running')).toBe('true')

    rerender(
      <WorkspacesPanel {...panelProps({ workspaces: [workspace], sessions: [bound], liveGeneratingSources: ['other'] })} />,
    )
    expect(document.querySelector('.session-dot')!.hasAttribute('data-running')).toBe(false)
  })
})

describe('聊天会话交互保留', () => {
  afterEach(async () => {
    const { cleanup } = await import('@testing-library/react')
    cleanup()
  })

  it('搜索按名称过滤；设置/删除回调携带会话 id', () => {
    const onDeleteSession = vi.fn(async () => {})
    const onOpenSessionSettings = vi.fn()
    const filtered = panelProps({
      query: '会话',
      sessions: [session(), session({ id: 's2', name: '其他', source: 'src-2' })],
      onDeleteSession,
      onOpenSessionSettings,
    })
    render(<ChatSessionsPanel {...filtered} />)
    expect(screen.getByText('会话一')).toBeInTheDocument()
    expect(screen.queryByText('其他')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '会话一 会话设置' }))
    expect(onOpenSessionSettings).toHaveBeenCalledWith('s1')
    fireEvent.click(screen.getByRole('button', { name: '删除 会话一' }))
    expect(onDeleteSession).toHaveBeenCalledWith('s1')
  })

  it('双击进入重命名，Enter 提交回调', () => {
    const onRenameSession = vi.fn()
    render(<ChatSessionsPanel {...panelProps({ onRenameSession })} />)
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
    render(<Sidebar ctx={ctx as never} state={{ sidebarMode: 'work' }} />)
    const toggle = screen.getByTitle('显示宠物')
    expect(toggle.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(toggle)
    expect(useWorkspaceStore.getState().showPet).toBe(true)
    expect(toggle.getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByTitle('隐藏宠物').getAttribute('aria-pressed')).toBe('true')
  })
})
