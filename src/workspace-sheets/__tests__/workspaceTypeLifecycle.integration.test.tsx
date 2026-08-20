// @vitest-environment jsdom
import { act, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { PluginRuntime } from '../../plugin-runtime/pluginRuntime'
import { resetStores } from '../../test/resetStores'
import { useWorkspaceStore } from '../../workspaceStore'
import SheetLayout from '../SheetLayout'

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
          component: ({ state }) => <div data-testid="dynamic-workspace">{String((state as { message: string }).message)}</div>,
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

    render(
      <SheetLayout
        activeSession={null}
        onSelectSession={() => {}}
        onProfileEdit={() => {}}
        onSessionSettings={() => {}}
        rightInset={0}
      />,
    )
    expect(screen.getByTestId('dynamic-workspace')).toHaveTextContent('active')

    await act(async () => {
      await runtime.deactivate(instance.identity.key)
    })

    expect(screen.queryByTestId('dynamic-workspace')).toBeNull()
    expect(screen.getByText('test.ui-lifecycle 尚未接入')).toBeInTheDocument()
  })
})
