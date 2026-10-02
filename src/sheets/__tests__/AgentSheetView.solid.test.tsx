// @vitest-environment jsdom
/**
 * #515：AgentSheetView Solid 实体的原生渲染路径（不经 React 桥）。
 *
 * 覆盖实体自身的分支与姿态语义（workbench 深层行为由 AgentSheetView.rendererMode.test.tsx
 * ——React 桥集成面——与 agent-workbench 域测试继续覆盖，断言集无缩减）：
 * 1. W4-02 姿态一次性手势：回放姿态与活动会话不匹配即清；
 * 2. 姿态匹配 → 只读回放覆盖层呈现，clear 后回聊天；
 * 3. 默认模式经 Renderer Suite 挂载内置 Solid Workbench；
 * 4. 整页分支优先于聊天区（resolveOpenPage 注入假贡献）。
 */
import { afterEach, afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@solidjs/testing-library'
import type { SheetContext, SheetRecord } from '../../workspace-sheets/sheetTypes.ts'
import { resetStores } from '../../test/resetStores.ts'
import AgentSheetView from '../AgentSheetView.solid.tsx'
import { useReplayPostureStore } from '../../domains/chat/replayPostureStore.ts'
import { activateBuiltinPlugin, getPluginRuntime } from '../../plugin-runtime/pluginCompositionRoot.ts'
import { FakeInvoke } from '../../test/fakeInvoke'

const { invokeRef, pageMock } = vi.hoisted(() => ({
  invokeRef: { current: null as null | ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) },
  pageMock: { openPage: null as unknown },
}))
// 整页分支注入假贡献（免注册完整 sidebar contribution；实体只消费 resolveOpenPage 结果）
vi.mock('../../plugin-runtime/sidebar/sidebarBlockState.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../../plugin-runtime/sidebar/sidebarBlockState.ts')>()
  return { ...actual, resolveOpenPage: () => pageMock.openPage as ReturnType<typeof actual.resolveOpenPage> }
})

vi.mock('@tauri-apps/api/core', async () => {
  const { tauriCoreMock } = await import('../../test-utils/tauriCoreMock')
  return tauriCoreMock((cmd, args) => invokeRef.current!(cmd, args))
})
/** 未注册命令 resolve undefined（对齐 rendererMode 集成测试的宽松路径） */
class TolerantFakeInvoke extends FakeInvoke {
  override invoke(cmd: string, args?: unknown): Promise<unknown> {
    return super.invoke(cmd, args).catch((error: unknown) => {
      if (error instanceof Error && error.message.startsWith('Command not found')) return undefined
      throw error
    })
  }
}

beforeAll(async () => {
  await activateBuiltinPlugin('builtin.pylon-renderers')
})

afterAll(async () => {
  const active = getPluginRuntime().snapshot().active.find(item => item.pluginId === 'builtin.pylon-renderers')
  if (active) await getPluginRuntime().deactivate(active.key)
})

// vitest globals 未开，solid testing-library 不自动 cleanup。
afterEach(cleanup)

const ctx: SheetContext = {
  openSheet: () => 'x', focusSheet() {}, closeSheet() {},
  activeSession: 'session-1', selectSession() {},
  openProfileEdit() {}, openSessionSettings() {},
  sidebarCollapsed: false, rightInset: 0, ccEditMode: false,
  sessionSource: () => 'local:s1', sessionBySource: () => undefined,
}

const sheet = (): SheetRecord => ({
  id: 'agent-sheet', kind: 'agent', title: 'Peri', agentId: 'peri',
  createdAt: 1, lastFocusedAt: 1, state: {},
})

describe('AgentSheetView.solid', () => {
  beforeEach(() => {
    invokeRef.current = (cmd, args) => new TolerantFakeInvoke().invoke(cmd, args)
    pageMock.openPage = null
    resetStores()
  })

  it('W4-02 姿态一次性手势：回放姿态与活动会话不匹配即清', async () => {
    useReplayPostureStore.setState({ sessionId: 'session-1' })
    render(() => <AgentSheetView sheet={sheet()} ctx={{ ...ctx, activeSession: 'session-2' }} />)
    await screen.findByLabelText('Solid Agent Workbench', {}, { timeout: 5_000 })
    expect(useReplayPostureStore.getState().sessionId).toBeNull()
  })

  it('姿态匹配 → 只读回放覆盖层呈现；点击继续（clear）后回聊天输入', async () => {
    useReplayPostureStore.setState({ sessionId: 'session-1' })
    const { container } = render(() => <AgentSheetView sheet={sheet()} ctx={ctx} />)
    await screen.findByLabelText('Solid Agent Workbench', {}, { timeout: 5_000 })
    const overlay = await waitFor(() => {
      const node = container.querySelector('.solid-workbench-replay-overlay')
      expect(node).not.toBeNull()
      expect(node!.textContent).toContain('历史回放 · 只读')
      return node!
    })
    // 姿态 clear（工作台「点击继续」事件路径最终走 store.clear）
    useReplayPostureStore.getState().clear()
    await waitFor(() => expect(container.querySelector('.solid-workbench-replay-overlay')).toBeNull())
    void overlay
  })

  it('默认模式经 Renderer Suite 挂载内置 Solid Workbench（实体直连路径）', async () => {
    const { container } = render(() => <AgentSheetView sheet={sheet()} ctx={ctx} />)
    expect(await screen.findByLabelText('Solid Agent Workbench', {}, { timeout: 5_000 })).toHaveAttribute('data-renderer', 'solid')
    expect(container.querySelector('[data-renderer-suite-host="true"]')).toHaveAttribute('data-suite-id', 'builtin.solid')
    expect(container.querySelector('.solid-workbench-replay-overlay')).toBeNull()
  })

  it('整页分支优先于聊天区（resolveOpenPage 命中时聊天区不挂载）', async () => {
    pageMock.openPage = { id: 'test.page', page: { title: '测试整页' }, renderKind: 'first-party', component: () => null }
    const { container } = render(() => <AgentSheetView sheet={sheet()} ctx={ctx} />)
    await waitFor(() => {
      const pageHost = container.querySelector('.agent-sheet-page[data-page-id="test.page"]')
      expect(pageHost).not.toBeNull()
      expect(pageHost!.querySelector('.agent-sheet-page-title')!.textContent).toBe('测试整页')
    })
    expect(screen.queryByLabelText('Solid Agent Workbench')).toBeNull()
  })
})
