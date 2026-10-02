// @vitest-environment jsdom
/** @jsxImportSource solid-js */
/**
 * #515：迁移自 workspaceTypeLifecycle.integration.test.tsx（React RTL → @solidjs/testing-library）。
 * 改写点登记：
 * - workspace 贡献 component 为 Solid Component（#515 契约翻转；props 形参读 state）；
 * - `render(<SheetLayout/>)` → `render(() => <SheetLayout/>)`，实体直连 SheetLayout.solid.tsx；
 * - `await act(async () => runtime.deactivate(...))` → `await runtime.deactivate(...)` +
 *   `await waitFor(() => 动态贡献消失)`（Solid 无 act；deactivate 为异步，registry 通知
 *   经 Solid 信号落 DOM，以真实条件等待）；
 * - 补显式 `afterEach(cleanup)`（vitest globals 未开）；
 * - 断言集逐字保留（dynamic-workspace 文案、停用后降级为「尚未接入」空态）。
 */
import { cleanup, render, screen, waitFor } from '@solidjs/testing-library'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TestPluginRuntime as PluginRuntime } from '../../plugin-runtime/testing/pluginRuntimeHarness.ts'
import { resetStores } from '../../test/resetStores'
import { useWorkspaceStore } from '../../domains/workspace/workspaceStore'
import SheetLayout from '../SheetLayout.solid.tsx'

// vitest globals 未开，solid testing-library 不自动 cleanup。
afterEach(cleanup)

describe('Workspace type v2 UI 生命周期', () => {
  beforeEach(() => {
    localStorage.clear()
    resetStores()
  })

  it('PluginScope 停用后 active workspace contribution 从真实布局消失', async () => {
    const runtime = new PluginRuntime()
    const instance = runtime.activateBuiltinSync({
      id: 'test.workspace-ui-lifecycle',
      activate: ({ workspace }) => {
        workspace.registerType({
          kind: 'test.ui-lifecycle',
          label: 'Lifecycle',
          singleton: true,
          getSingletonKey: () => 'test.ui-lifecycle',
          sidebarMode: 'none',
          component: props => <div data-testid="dynamic-workspace">{String((props.state as { message: string }).message)}</div>,
          createInitialState: input => input,
          serialize: state => state,
          deserialize: raw => raw ?? { message: 'missing' },
        })
      },
    })
    useWorkspaceStore.getState().openSheet({
      kind: 'test.ui-lifecycle',
      title: 'Lifecycle',
      state: { message: 'active' },
    })

    render(() => (
      <SheetLayout
        activeSession={null}
        onSelectSession={() => {}}
        onProfileEdit={() => {}}
        onSessionSettings={() => {}}
      />
    ))
    expect(screen.getByTestId('dynamic-workspace')).toHaveTextContent('active')

    await runtime.deactivate(instance.identity.key)
    await waitFor(() => expect(screen.queryByTestId('dynamic-workspace')).toBeNull())

    expect(screen.queryByTestId('dynamic-workspace')).toBeNull()
    expect(screen.getByText('test.ui-lifecycle 尚未接入')).toBeInTheDocument()
  })
})
