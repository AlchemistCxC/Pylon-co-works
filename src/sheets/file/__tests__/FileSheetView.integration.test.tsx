// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest'
import '../../../plugin-runtime/testing/productPluginTestBootstrap.ts'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import FileSheetView from '../FileSheetView'
import { useWorkspaceStore } from '../../../workspaceStore'
import { toAgentContextKey } from '../../../agentContext'
import { resetStores } from '../../../test/resetStores'
import { createSheetState } from '../../../workspace-sheets/sheetState'
import { fileTabKey, serializeFileTabs, type FileTabRecord, type FileTabState } from '../fileSheetState'
import type { SheetContext, SheetRecord } from '../../../workspace-sheets/sheetTypes'
import { useIdentityStore } from '../../../identityStore'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke }))
vi.mock('../../../components/chat/codeHighlight', () => ({ highlightCode: vi.fn().mockResolvedValue(null) }))

const ctx: SheetContext = {
  openSheet: vi.fn(),
  focusSheet: vi.fn(),
  closeSheet: vi.fn(),
  activeSession: null,
  selectSession: vi.fn(),
  openProfileEdit: vi.fn(),
  openSessionSettings: vi.fn(),
  sidebarCollapsed: false,
  rightInset: 0,
  ccEditMode: false,
  sessionSource: () => 'ws-a',
  sessionBySource: source => useIdentityStore.getState().sessions.find(session => session.source === source),
}

function seedSheet(metadata: Record<string, string>) {
  const sheet: SheetRecord = {
    id: 'file-1',
    kind: 'file',
    title: '文件',
    agentId: 'agent-test',
    singletonKey: 'file:ws-a',
    createdAt: 0,
    lastFocusedAt: 0,
    metadata,
  }
  useWorkspaceStore.setState({ workspaceSheets: createSheetState([sheet], 'file-1') })
}

function seedUnboundSheet() {
  const sheet: SheetRecord = {
    id: 'file-1',
    kind: 'file',
    title: '文件',
    agentId: 'agent-test',
    createdAt: 0,
    lastFocusedAt: 0,
    metadata: {},
  }
  useWorkspaceStore.setState({ workspaceSheets: createSheetState([sheet], 'file-1') })
}

function FileSheetHarness() {
  const sheet = useWorkspaceStore(s => s.workspaceSheets.sheets.find(item => item.id === 'file-1'))
  if (!sheet) return null
  return <FileSheetView sheet={sheet} ctx={ctx} />
}

function renderHarness() {
  return render(<FileSheetHarness />)
}

function readTextResult(relativePath: string, content: string) {
  return { relativePath, content, bytesRead: content.length, totalBytes: content.length, truncated: false }
}

describe('FileSheetView 版本化 tab 集成（D-02/D-04）', () => {
  beforeEach(() => {
    resetStores()
    useIdentityStore.setState({ sessions: [{ id: 'session-a', agentId: 'agent-test', source: 'ws-a', name: 'Workspace A', profileId: 'p', createdAt: 1, lastActiveAt: 1, platform: 'local', workdir: 'C:/workspace', sessionPrompt: '', skills: [], hooks: [], autoName: '' }] })
    localStorage.clear()
    invoke.mockReset()
    invoke.mockImplementation((cmd: string, args: { source?: string; relativePath?: string } | undefined) => {
      if (cmd === 'list_workspace_entries') return Promise.resolve([])
      if (cmd === 'read_workspace_text') {
        const content = args?.relativePath === 'src/c.ts' ? 'const c = 3' : 'const x = 1'
        return Promise.resolve(readTextResult(args?.relativePath ?? '', content))
      }
      if (cmd === 'git_status_with_branch') {
        return Promise.resolve({ branch: { branch: null, detached: false, head: null }, entries: [{ path: 'src/c.ts', status: 'M', staged: true }] })
      }
      if (cmd === 'git_history') return Promise.resolve([])
      if (cmd === 'git_diff') return Promise.resolve('--- a/src/c.ts\n+++ b/src/c.ts\n@@ -1,1 +1,1 @@\n-const c = 2\n+const c = 3')
      return Promise.reject(new Error(`unexpected invoke ${cmd}`))
    })
  })

  it('v1 openTabs:string[] 迁移为 file-mode tabs，activeKey 取最后一条', async () => {
    seedSheet({ openTabs: JSON.stringify(['src/a.ts', 'src/b.ts']) })
    renderHarness()
    await screen.findByText('src/b.ts', {}, { timeout: 10_000 })
    expect(screen.getByTitle('src/a.ts')).toBeTruthy()
    await waitFor(() => expect(document.querySelector('.file-tab-view')?.getAttribute('data-path')).toBe('src/b.ts'))
  })

  it('从会话分区选择工作区会话后自动展示文件树，并以 workspaceId 请求根目录', async () => {
    useIdentityStore.setState({ sessions: [{
      id: 'session-workspace', agentId: 'agent-test', source: 'workspace-source', name: 'Pylon Workspace',
      profileId: 'p', createdAt: 1, lastActiveAt: 1, platform: 'local', workdir: 'C:/stale-snapshot',
      workspaceId: 'workspace-1', sessionPrompt: '', skills: [], hooks: [], autoName: '',
    }] })
    seedUnboundSheet()
    const view = renderHarness()

    fireEvent.click(screen.getByLabelText('会话：切换工作区会话'))
    fireEvent.click(await screen.findByText('Pylon Workspace'))

    await screen.findByText('EXPLORER')
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('list_workspace_entries', {
      target: {
        sessionId: 'session-workspace',
        agentId: 'agent-test',
        source: 'workspace-source',
        workspaceId: 'workspace-1',
      },
      relativePath: '',
    }))
    expect(useWorkspaceStore.getState().workspaceSheets.sheets[0]?.metadata?.targetSessionId).toBe('session-workspace')

    invoke.mockClear()
    view.unmount()
    renderHarness()
    await screen.findByText('EXPLORER')
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('list_workspace_entries', expect.objectContaining({
      target: expect.objectContaining({ workspaceId: 'workspace-1' }),
    })))
  })

  it('文件 provider 返回规范化 WorkspaceEntry 时不会被二次归一化清空', async () => {
    invoke.mockImplementation((cmd: string) => {
      if (cmd === 'list_workspace_entries') return Promise.resolve([
        { name: 'src', relativePath: 'src', kind: 'directory' },
        { name: 'package.json', relativePath: 'package.json', kind: 'file' },
      ])
      return Promise.reject(new Error(`unexpected invoke ${cmd}`))
    })
    seedSheet({})
    renderHarness()

    expect(await screen.findByTitle('src')).toBeTruthy()
    expect(screen.getByTitle('package.json')).toBeTruthy()
    expect(screen.queryByText('工作区为空')).toBeNull()
  })

  it('SCM 点击变更 → 打开 diff-mode tab（tab 条保留，主区显示 diff，git_diff 带 staged）', async () => {
    seedSheet({})
    renderHarness()
    fireEvent.click(screen.getByLabelText('SCM：查看完整 Git 状态和历史'))
    const row = await screen.findByTitle('src/c.ts')
    fireEvent.click(row)
    await screen.findByText('变更预览')
    // tab 条：diff-mode tab 保留（非替换主区）
    expect(screen.getByTitle('src/c.ts（diff）')).toBeTruthy()
    expect(screen.getByText('src/c.ts（staged）')).toBeTruthy()
    expect(invoke).toHaveBeenCalledWith('git_diff', {
      target: { sessionId: 'session-a', agentId: 'agent-test', source: 'ws-a', legacyWorkdir: 'C:/workspace' },
      path: 'src/c.ts',
      staged: true,
    })
  })

  it('同路径 file/diff tab 并存，切换不串 mode', async () => {
    const tabs: FileTabRecord[] = [
      { path: 'src/a.ts', mode: 'file' },
      { path: 'src/a.ts', mode: 'diff', staged: true },
    ]
    const state: FileTabState = { version: 2, tabs, activeKey: fileTabKey(tabs[1]) }
    seedSheet({ openTabs: serializeFileTabs(state) })
    renderHarness()
    await screen.findByText('变更预览')
    expect(screen.getByTitle('src/a.ts')).toBeTruthy()
    expect(screen.getByTitle('src/a.ts（diff）')).toBeTruthy()
    fireEvent.click(screen.getByTitle('src/a.ts'))
    await waitFor(() => expect(document.querySelector('.file-tab-view')?.getAttribute('data-path')).toBe('src/a.ts'))
    expect(screen.queryByText('变更预览')).toBeNull()
    // 切回 diff tab → diff 恢复，文件视图不再
    fireEvent.click(screen.getByTitle('src/a.ts（diff）'))
    await screen.findByText('变更预览')
    expect(document.querySelector('.file-tab-view')).toBeNull()
  })

  it('Views 点击触碰文件 → file-mode tab（普通文件视图）', async () => {
    seedSheet({})
    useWorkspaceStore.setState({ touchedFiles: { [toAgentContextKey({ agentId: 'agent-test', source: 'ws-a' })]: [{ source: 'ws-a', path: 'src/touched.ts', toolKind: 'Edit', at: 1000 }] } })
    renderHarness()
    fireEvent.click(screen.getByLabelText('视图：查看 Agent 最近触碰文件'))
    fireEvent.click(await screen.findByText('src/touched.ts'))
    await waitFor(() => expect(document.querySelector('.file-tab-view')?.getAttribute('data-path')).toBe('src/touched.ts'))
    expect(screen.getAllByTitle('src/touched.ts').length).toBeGreaterThan(0)
  })
})
