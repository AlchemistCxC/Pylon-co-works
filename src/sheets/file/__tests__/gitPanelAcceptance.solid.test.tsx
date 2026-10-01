// @vitest-environment jsdom
/**
 * ISSUE-15 三级验收·前端网页层（browser fixture）：mock 后端证明 DOM 行为。
 * - 空格/中文/rename 路径经 porcelain v2 -z 后端（WI01/02 已修）到达前端后，
 *   GitPanel 树正确渲染、diff 以原路径请求（不因引号/切分失真）。
 * - 只证明 browser fixture/DOM 行为，不证明 Tauri/ACP/外部服务（ISSUE-15 验收设计）。
 * - branch 显示 / 附件超限错误态依赖冻结中的 WI04，不在此文件覆盖（WI04 解冻后补）。
 *
 * #515：迁移自 gitPanelAcceptance.test.tsx（React RTL → Solid 实体直连，经 FileSheetView
 * 实体全链路）。断言改写点登记：
 * 1. render(<FileSheetHarness/>)（React zustand hook 订阅）→ render(() => <FileSheetHarness/>)
 *   （createZustandSignal 订阅——useXxxStore(selector) 是 React shim hook，Solid 组件内
 *   不可用）；渲染函数传参语义不变；
 * 2. vi.mock('../../../app/runtimeError')：React 版依赖 vitest.setup.ts 的 console.error
 *   白名单吸收 not-repo 路径的 reportRuntimeError 噪音；Solid 版文件名不同（.solid），
 *   白名单不改（setup 文件不在本迁移域），改以 mock 上报通道吸收同族噪音——not-repo
 *   断言只看 DOM，与上报通道无关。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import '../../../plugin-runtime/testing/productPluginTestBootstrap.ts'
import { fireEvent, render, screen, cleanup } from '@solidjs/testing-library'
import { createZustandSignal } from '../../../host/solidStoreBridge.ts'
import FileSheetView from '../FileSheetView.solid.tsx'
import { useWorkspaceStore } from '../../../domains/workspace/workspaceStore'
import { resetStores } from '../../../test/resetStores'
import { createSheetState } from '../../../domains/workspace/sheetState'
import type { SheetContext, SheetRecord } from '../../../workspace-sheets/sheetTypes'
import { useIdentityStore } from '../../../domains/identity/identityStore'

afterEach(() => cleanup())

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', async () => {
  const { tauriCoreMock } = await import('../../../test-utils/tauriCoreMock')
  return tauriCoreMock(invoke)
})
vi.mock('../../../app/runtimeError', () => ({ reportRuntimeError: vi.fn(), resolveRuntimeErrors: vi.fn() }))
vi.mock('../../../domains/chat/codeHighlight', () => ({ highlightCode: vi.fn().mockResolvedValue(null) }))
const ASYNC_PANEL_TIMEOUT = { timeout: 10_000 }

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
  const sheet = createZustandSignal(useWorkspaceStore, s => s.workspaceSheets.sheets.find(item => item.id === 'file-1'))
  // 不用 keyed Show：sheet 每次写盘都是新对象，keyed 会销毁重建整棵 FileSheetView
  //（React 版为同实例重渲染，组件状态必须跨 patch 存活）——测试始终先 seed 再渲染。
  return <FileSheetView sheet={sheet()!} ctx={ctx} />
}

function renderHarness() {
  return render(() => <FileSheetHarness />)
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
    const row = await screen.findByTitle(spacedPath, {}, ASYNC_PANEL_TIMEOUT)
    expect(row.textContent).toContain('my file with spaces.txt')
    fireEvent.click(row)
    await screen.findByText('变更预览', {}, ASYNC_PANEL_TIMEOUT)
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
    const row = await screen.findByTitle(renamed, {}, ASYNC_PANEL_TIMEOUT)
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
    const row = await screen.findByTitle(cnPath, {}, ASYNC_PANEL_TIMEOUT)
    expect(row.textContent).toContain('测试文档.txt')
    fireEvent.click(row)
    await screen.findByText('变更预览', {}, ASYNC_PANEL_TIMEOUT)
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
    await screen.findByText('当前工作区不是 Git 仓库', {}, ASYNC_PANEL_TIMEOUT)
    expect(screen.queryByText('STAGED')).toBeNull()
  })
})

// ── ISSUE-15 W4 前端 branch consumer fixture ──
// （原 RED fixtures 已随 WI04 落地转绿；断言不变，只随 #515 迁移渲染面。）

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
    await screen.findByText('feature/x', {}, ASYNC_PANEL_TIMEOUT)
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
    await screen.findByText('(detached)', {}, ASYNC_PANEL_TIMEOUT)
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
    await screen.findByText('—', {}, ASYNC_PANEL_TIMEOUT)
  })
})
