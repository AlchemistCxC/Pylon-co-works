// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { useWorkspaceStore } from '../../workspaceStore.ts'
import { SETTINGS_SHEET_KIND, openOrFocusSettingsSheet } from '../settingsSheetNavigation.ts'
import '../../plugin-runtime/testing/productPluginTestBootstrap.ts'

describe('openOrFocusSettingsSheet（#154 阶段 4）', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('关闭态：带归一意图打开 singleton settings sheet', () => {
    const id = openOrFocusSettingsSheet({ domain: 'workspace' })
    expect(id).toBeTruthy()
    const store = useWorkspaceStore.getState()
    const sheet = store.workspaceSheets.sheets.find(item => item.id === id)
    expect(sheet?.kind).toBe(SETTINGS_SHEET_KIND)
    expect(sheet?.state).toMatchObject({ domain: 'workspace', section: 'window' })
    expect(store.workspaceSheets.activeSheetId).toBe(id)
  })

  it('已打开：不新开，patch 导航态并聚焦（幂等）', () => {
    const first = openOrFocusSettingsSheet({ domain: 'workspace' })
    const before = useWorkspaceStore.getState().workspaceSheets.sheets.length
    const second = openOrFocusSettingsSheet({ domain: 'plugins' })
    const store = useWorkspaceStore.getState()

    expect(second).toBe(first)
    expect(store.workspaceSheets.sheets).toHaveLength(before)
    expect(store.workspaceSheets.sheets.find(item => item.id === first)?.state).toMatchObject({
      domain: 'plugins', section: 'pluginManager',
    })
    expect(store.workspaceSheets.activeSheetId).toBe(first)
  })

  it('深链别名经同一归一口（renderer/suite → 外观 › 渲染器）', () => {
    const id = openOrFocusSettingsSheet({ domain: 'renderer', section: 'suite' })
    const sheet = useWorkspaceStore.getState().workspaceSheets.sheets.find(item => item.id === id)
    expect(sheet?.state).toMatchObject({ domain: 'appearance', section: 'renderers' })
  })
})
