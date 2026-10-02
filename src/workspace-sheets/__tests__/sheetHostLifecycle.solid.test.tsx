// @vitest-environment jsdom
/** @jsxImportSource solid-js */
/**
 * #515：迁移自 sheetHostLifecycle.test.tsx（React RTL → @solidjs/testing-library）。
 * 改写点登记：
 * - registry 贡献 component 为 Solid Component（#515 workspace 契约翻转）；探针的
 *   React `useEffect([], cleanup)` → Solid `onMount(onCleanup)`（mount/unmount 计数语义一致）；
 * - React `view.rerender(<SheetHost ctx={新对象}/>)` → 信号驱动 props 更新
 *   （Solid 无 rerender：ctx 以 `createContext(collapsed())` 形式传入，信号翻转即
 *   ctx 换新引用，等价于 React 的 props 更新路径）；
 * - 补显式 `afterEach(cleanup)`（vitest globals 未开）；
 * - 断言集逐字保留（mounts=1、ctx 更新不卸载、unmount 后 unmounts=1）。
 */
import { createSignal, onCleanup, onMount } from 'solid-js'
import { cleanup, render } from '@solidjs/testing-library'
import { afterEach, describe, expect, it } from 'vitest'
import { createPluginIdentity } from '../../plugin-runtime/pluginIdentity'
import SheetHost from '../SheetHost.solid.tsx'
import type { SheetContext, SheetRecord } from '../sheetTypes'
import { registerWorkspace } from '../../plugin-runtime/workspaces/workspaceRegistry'

const sheet: SheetRecord = {
  id: 'sheet-host-lifecycle',
  kind: 'test-sheet-host-lifecycle',
  title: 'Lifecycle probe',
  createdAt: 1,
  lastFocusedAt: 1,
}

function createContext(sidebarCollapsed: boolean): SheetContext {
  return {
    openSheet: () => null,
    focusSheet: () => {},
    closeSheet: () => {},
    activeSession: null,
    selectSession: () => {},
    openProfileEdit: () => {},
    openSessionSettings: () => {},
    sidebarCollapsed,
    rightInset: 0,
    sessionSource: () => null,
    sessionBySource: () => undefined,
  }
}

// vitest globals 未开，solid testing-library 不自动 cleanup。
afterEach(cleanup)

describe('SheetHost 生命周期稳定性', () => {
  it('仅更新 SheetContext 时不卸载正在运行的 Sheet', () => {
    let mounts = 0
    let unmounts = 0

    function LifecycleProbe() {
      onMount(() => {
        mounts += 1
        onCleanup(() => {
          unmounts += 1
        })
      })
      return null
    }

    const registration = registerWorkspace(
      createPluginIdentity('test.sheet-host-lifecycle', 'context-update'),
      {
        kind: sheet.kind,
        label: 'Lifecycle probe',
        singleton: true,
        getSingletonKey: () => sheet.id,
        sidebarMode: 'none',
        component: LifecycleProbe,
        createInitialState: () => undefined,
        serialize: state => state,
        deserialize: raw => raw,
      },
    )

    try {
      // Solid 无 rerender：ctx 以信号驱动换新引用，等价 React 版的 rerender props 更新
      const [collapsed, setCollapsed] = createSignal(false)
      const view = render(() => <SheetHost sheet={sheet} ctx={createContext(collapsed())} />)
      expect(mounts).toBe(1)
      expect(unmounts).toBe(0)

      setCollapsed(true)

      expect(mounts).toBe(1)
      expect(unmounts).toBe(0)
      view.unmount()
      expect(unmounts).toBe(1)
    } finally {
      registration.dispose()
    }
  })
})
