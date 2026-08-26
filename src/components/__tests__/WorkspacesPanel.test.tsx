// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import WorkspacesPanel from '../sidebar/WorkspacesPanel'
import { resetStores } from '../../test/resetStores'
import type { AgentSidebarContributionProps } from '../../plugin-runtime/sidebar/sidebarTypes'
import { useWorkspaceEntityStore } from '../../workspaceEntityStore'

const { invoke, open } = vi.hoisted(() => ({
  invoke: vi.fn(),
  open: vi.fn(),
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke }))
vi.mock('@tauri-apps/plugin-dialog', () => ({ open }))

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

function createProps(overrides: Partial<AgentSidebarContributionProps> = {}): AgentSidebarContributionProps {
  return {
    activeAgentId: 'peri',
    query: '',
    activeSessionId: null,
    sessions: [],
    workspaces: [workspace],
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

describe('WorkspacesPanel', () => {
  beforeEach(() => {
    resetStores()
    localStorage.clear()
    invoke.mockReset()
    invoke.mockResolvedValue([])
    open.mockReset()
    open.mockResolvedValue(null)
  })

  it('通过系统目录选择器选择根目录并自动生成工作区名称', async () => {
    const onCreateWorkspace = vi.fn(async () => {})
    open.mockResolvedValue('C:\\Users\\Tester\\pylon-demo')
    render(<WorkspacesPanel {...createProps({ onCreateWorkspace })} />)

    fireEvent.click(screen.getByRole('button', { name: '新建工作区' }))

    await waitFor(() => expect(open).toHaveBeenCalledWith({
      directory: true,
      multiple: false,
      title: '选择工作区文件夹',
    }))
    expect(screen.getByRole('textbox', { name: '工作区名称' })).toHaveValue('pylon-demo')
    expect(screen.getByTitle('C:\\Users\\Tester\\pylon-demo')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '创建' }))
    await waitFor(() => expect(onCreateWorkspace).toHaveBeenCalledWith('pylon-demo', 'C:\\Users\\Tester\\pylon-demo'))
    expect(screen.queryByRole('textbox', { name: '工作区名称' })).not.toBeInTheDocument()
  })

  it('将工作区设置作为弹出式对话框呈现', async () => {
    render(<WorkspacesPanel {...createProps()} />)

    const list = screen.getByRole('region', { name: '工作会话' })
    fireEvent.click(within(list).getByRole('button', { name: 'Pylon 工作区设置' }))

    const settings = screen.getByRole('dialog')
    expect(within(settings).getByText('G:/Project/Pylon')).toBeInTheDocument()
    expect(within(settings).getByText('Skills（逗号分隔）')).toBeInTheDocument()
    expect(within(settings).queryByRole('button', { name: '在 Pylon 中新建会话' })).not.toBeInTheDocument()

    fireEvent.click(within(settings).getByRole('button', { name: '关闭工作区设置' }))
    expect(screen.getByRole('region', { name: '工作会话' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '在 Pylon 中新建会话' })).toBeInTheDocument()
  })

  it('工作区设置会实际保存名称、目录、Skills 与 Hook，而不是安慰按钮', async () => {
    useWorkspaceEntityStore.setState({ workspaces: [workspace], hydrated: true })
    render(<WorkspacesPanel {...createProps()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Pylon 工作区设置' }))

    fireEvent.change(screen.getByRole('textbox', { name: '工作区名称' }), { target: { value: 'Pylon Desktop' } })
    fireEvent.change(screen.getByRole('textbox', { name: '工作目录' }), { target: { value: '/path/to/project' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Skills（逗号分隔）' }), { target: { value: 'review, test' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Hook 插件（逗号分隔）' }), { target: { value: 'hooks.audit' } })
    fireEvent.click(screen.getByRole('button', { name: '保存更改' }))

    await waitFor(() => expect(useWorkspaceEntityStore.getState().workspaces[0]).toMatchObject({
      name: 'Pylon Desktop',
      rootPath: '/path/to/project',
      skills: ['review', 'test'],
      hookPluginIds: ['hooks.audit'],
    }))
  })

  it('持久化每个工作区的展开状态，并支持键盘选择会话', async () => {
    const onSelectSession = vi.fn()
    const session = {
      id: 'session-1', agentId: 'peri', name: '实现界面', source: 'local:1', profileId: 'profile-a',
      createdAt: 1, lastActiveAt: 1, platform: 'local', workdir: workspace.rootPath, workspaceId: workspace.id,
      sessionPrompt: '', skills: [], hooks: [], autoName: '', metadata: {}, context: {},
    }
    const view = render(<WorkspacesPanel {...createProps({ sessions: [session], onSelectSession })} />)

    fireEvent.keyDown(screen.getByText('实现界面').closest('[role="treeitem"]')!, { key: 'Enter' })
    expect(onSelectSession).toHaveBeenCalledWith('session-1')
    fireEvent.click(screen.getByRole('button', { name: '折叠 Pylon' }))
    await waitFor(() => expect(localStorage.getItem('pylon-workspace-tree:v1')).toContain('workspace-1'))

    view.unmount()
    render(<WorkspacesPanel {...createProps({ sessions: [session] })} />)
    expect(screen.getByRole('button', { name: '展开 Pylon' })).toBeInTheDocument()
    const collapsedSessions = document.querySelector('.cwd-group-sessions.is-collapsed')
    expect(collapsedSessions).toHaveAttribute('aria-hidden', 'true')
  })

  it('将工作区身份与计数/操作分成稳定几何层', () => {
    render(<WorkspacesPanel {...createProps()} />)
    const toggle = screen.getByRole('button', { name: '折叠 Pylon' })
    const count = screen.getByLabelText('0 个会话')
    const head = toggle.closest('.cwd-group-head')!

    expect(toggle).toContainElement(screen.getByText('G:/Project/Pylon'))
    expect(toggle).not.toContainElement(count)
    expect(head).toContainElement(count)
    expect(head).toContainElement(screen.getByRole('button', { name: '在 Pylon 中新建会话' }))
    expect(head).toContainElement(screen.getByRole('button', { name: 'Pylon 工作区设置' }))
  })
})
