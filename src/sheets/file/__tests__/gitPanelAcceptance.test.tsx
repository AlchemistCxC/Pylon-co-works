// @vitest-environment jsdom
/**
 * ISSUE-15 三级验收·前端网页层（browser fixture）：mock 后端证明 DOM 行为。
 * - 空格/中文/rename 路径经 porcelain v2 -z 后端（WI01/02 已修）到达前端后，
 *   GitPanel 树正确渲染、diff 以原路径请求（不因引号/切分失真）。
 * - 只证明 browser fixture/DOM 行为，不证明 Tauri/ACP/外部服务（ISSUE-15 验收设计）。
 * - branch 显示 / 附件超限错误态依赖冻结中的 WI04，不在此文件覆盖（WI04 解冻后补）。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import '../../../plugin-runtime/testing/productPluginTestBootstrap.ts'
import { render, screen, fireEvent } from '@testing-library/react'
import FileSheetView from '../FileSheetView'
import { useWorkspaceStore } from '../../../workspaceStore'
import { resetStores } from '../../../test/resetStores'
import { createSheetState } from '../../../workspace-sheets/sheetState'
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
    singletonKey: 'file:session:session-a',
    createdAt: 0,
    lastFocusedAt: 0,
    metadata,
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

function openScm() {
  seedSheet({})
  renderHarness()
  fireEvent.click(screen.getByLabelText('SCM：查看完整 Git 状态和历史'))
}

describe('ISSUE-15 前端网页层 fixture（空格/中文/rename 路径）', () => {
  beforeEach(() => {
    resetStores()
    useIdentityStore.setState({ sessions: [{ id: 'session-a', agentId: 'agent-test', source: 'ws-a', name: 'Workspace A', profileId: 'p', createdAt: 1, lastActiveAt: 1, platform: 'local', workdir: 'C:/workspace', sessionPrompt: '', skills: [], hooks: [], autoName: '' }] })
    localStorage.clear()
    invoke.mockReset()
  })

  it('含空格路径：树渲染原路径，diff 以原路径请求（不被引号/切分失真）', async () => {
    // WI01/02 后端保证 v2 -z 路径无引号；前端必须原样渲染并回传 diff 请求
    const spacedPath = 'my file with spaces.txt'
    invoke.mockImplementation((cmd: string) => {
      if (cmd === 'list_workspace_entries') return Promise.resolve([])
      if (cmd === 'git_status_with_branch') {
        return Promise.resolve({ branch: { branch: null, detached: false, head: null }, entries: [{ path: spacedPath, status: ' M', staged: false }] })
      }
      if (cmd === 'git_history') return Promise.resolve([])
      if (cmd === 'git_diff') return Promise.resolve('--- a/my file with spaces.txt\n+++ b/my file with spaces.txt\n@@ -1,1 +1,1 @@\n-old\n+new')
      return Promise.reject(new Error(`unexpected invoke ${cmd}`))
    })
    openScm()
    const row = await screen.findByTitle(spacedPath)
    expect(row.textContent).toContain('my file with spaces.txt')
    fireEvent.click(row)
    await screen.findByText('变更预览')
    expect(invoke).toHaveBeenCalledWith('git_diff', {
      target: { sessionId: 'session-a', agentId: 'agent-test', source: 'ws-a', legacyWorkdir: 'C:/workspace' },
      path: spacedPath,
      staged: false,
    })
    expect(screen.getByTitle(`${spacedPath}（diff）`)).toBeTruthy()
  })

  it('rename 目标路径（含空格）：STAGED 区渲染原路径与 R 状态码', async () => {
    // porcelain v2 rename 条目后端返回目标路径（WI01 AC-2）；前端树按目标展示
    const renamed = 'renamed file.txt'
    invoke.mockImplementation((cmd: string) => {
      if (cmd === 'list_workspace_entries') return Promise.resolve([])
      if (cmd === 'git_status_with_branch') {
        return Promise.resolve({ branch: { branch: null, detached: false, head: null }, entries: [{ path: renamed, status: 'R ', staged: true }] })
      }
      if (cmd === 'git_history') return Promise.resolve([])
      if (cmd === 'git_diff') return Promise.resolve('--- a/old.txt\n+++ b/renamed file.txt\n@@ -1,1 +1,1 @@\n-old\n+new')
      return Promise.reject(new Error(`unexpected invoke ${cmd}`))
    })
    openScm()
    const row = await screen.findByTitle(renamed)
    expect(row.textContent).toContain('renamed file.txt')
    expect(row.textContent).toContain('R')
    // 位于 STAGED 区
    const stagedSection = screen.getByText('STAGED').closest('section')
    expect(stagedSection?.textContent).toContain(renamed)
  })

  it('中文路径：树渲染原路径且 diff 请求原路径（后端 quotePath 修复链路）', async () => {
    const cnPath = 'src/测试文档.txt'
    invoke.mockImplementation((cmd: string) => {
      if (cmd === 'list_workspace_entries') return Promise.resolve([])
      if (cmd === 'git_status_with_branch') {
        return Promise.resolve({ branch: { branch: null, detached: false, head: null }, entries: [{ path: cnPath, status: ' M', staged: false }] })
      }
      if (cmd === 'git_history') return Promise.resolve([])
      if (cmd === 'git_diff') return Promise.resolve('--- a/src/测试文档.txt\n+++ b/src/测试文档.txt\n@@ -1,1 +1,1 @@\n-old\n+new')
      return Promise.reject(new Error(`unexpected invoke ${cmd}`))
    })
    openScm()
    const row = await screen.findByTitle(cnPath)
    expect(row.textContent).toContain('测试文档.txt')
    fireEvent.click(row)
    await screen.findByText('变更预览')
    expect(invoke).toHaveBeenCalledWith('git_diff', {
      target: { sessionId: 'session-a', agentId: 'agent-test', source: 'ws-a', legacyWorkdir: 'C:/workspace' },
      path: cnPath,
      staged: false,
    })
  })

  it('非 git 仓库错误：not-repo 提示不渲染树（classifyGitError 链路）', async () => {
    invoke.mockImplementation((cmd: string) => {
      if (cmd === 'list_workspace_entries') return Promise.resolve([])
      if (cmd === 'git_status_with_branch') return Promise.reject(new Error('not a git repository'))
      if (cmd === 'git_history') return Promise.reject(new Error('not a git repository'))
      return Promise.reject(new Error(`unexpected invoke ${cmd}`))
    })
    openScm()
    await screen.findByText('当前工作区不是 Git 仓库')
    expect(screen.queryByText('STAGED')).toBeNull()
  })
})

// ── ISSUE-15 W4 RED fixtures：GitPanel 展示后端真实 branch/detached（修复前必须失败）──
// 当前 GitPanel 硬编码 <strong>main</strong> 且调用 git_status（非 git_status_with_branch）；
// 以下用例按目标形态断言（mock git_status_with_branch 返回真实分支）→ 当前实现 RED。

describe('ISSUE-15 W4 前端 branch consumer fixture', () => {
  beforeEach(() => {
    resetStores()
    useIdentityStore.setState({ sessions: [{ id: 'session-a', agentId: 'agent-test', source: 'ws-a', name: 'Workspace A', profileId: 'p', createdAt: 1, lastActiveAt: 1, platform: 'local', workdir: 'C:/workspace', sessionPrompt: '', skills: [], hooks: [], autoName: '' }] })
    localStorage.clear()
    invoke.mockReset()
  })

  it('展示后端返回的真实分支名（非硬编码 main）', async () => {
    invoke.mockImplementation((cmd: string) => {
      if (cmd === 'list_workspace_entries') return Promise.resolve([])
      if (cmd === 'git_status_with_branch') {
        return Promise.resolve({ branch: { branch: 'feature/x', detached: false, head: 'abc123def456' }, entries: [] })
      }
      if (cmd === 'git_history') return Promise.resolve([])
      return Promise.reject(new Error(`unexpected invoke ${cmd}`))
    })
    openScm()
    await screen.findByText('feature/x')
    expect(screen.queryByText('main')).toBeNull()
  })

  it('detached HEAD 显示 (detached) 而非分支名', async () => {
    invoke.mockImplementation((cmd: string) => {
      if (cmd === 'list_workspace_entries') return Promise.resolve([])
      if (cmd === 'git_status_with_branch') {
        return Promise.resolve({ branch: { branch: null, detached: true, head: 'abc123def456' }, entries: [] })
      }
      if (cmd === 'git_history') return Promise.resolve([])
      return Promise.reject(new Error(`unexpected invoke ${cmd}`))
    })
    openScm()
    await screen.findByText('(detached)')
  })

  it('无分支信息时显示占位（branch=null 且非 detached）', async () => {
    invoke.mockImplementation((cmd: string) => {
      if (cmd === 'list_workspace_entries') return Promise.resolve([])
      if (cmd === 'git_status_with_branch') {
        return Promise.resolve({ branch: { branch: null, detached: false, head: null }, entries: [] })
      }
      if (cmd === 'git_history') return Promise.resolve([])
      return Promise.reject(new Error(`unexpected invoke ${cmd}`))
    })
    openScm()
    await screen.findByText('—')
  })
})
