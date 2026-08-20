// @vitest-environment jsdom
import { useEffect } from 'react'
import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { createPluginIdentity } from '../../plugin-runtime/pluginIdentity'
import SheetHost from '../SheetHost'
import type { SheetContext, SheetRecord } from '../sheetTypes'
import { registerWorkspace } from '../workspaceRegistry'

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
    ccEditMode: false,
    sessionSource: () => null,
    sessionBySource: () => undefined,
  }
}

describe('SheetHost 生命周期稳定性', () => {
  it('仅更新 SheetContext 时不卸载正在运行的 Sheet', () => {
    let mounts = 0
    let unmounts = 0

    function LifecycleProbe() {
      useEffect(() => {
        mounts += 1
        return () => {
          unmounts += 1
        }
      }, [])
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
      const view = render(<SheetHost sheet={sheet} ctx={createContext(false)} />)
      expect(mounts).toBe(1)
      expect(unmounts).toBe(0)

      view.rerender(<SheetHost sheet={sheet} ctx={createContext(true)} />)

      expect(mounts).toBe(1)
      expect(unmounts).toBe(0)
      view.unmount()
      expect(unmounts).toBe(1)
    } finally {
      registration.dispose()
    }
  })
})
