import { describe, expect, it } from 'vitest'
import {
  FIRST_PARTY_STYLE_OWNERSHIP,
  listFirstPartyStylesByOwner,
} from '../firstPartyStyleOwnership.ts'

const expectedCssPaths = [
  'src/components/kernel/SkinPreviewBar.css',
  'src/index.css',
  'src/plugins/product/packages/builtin.pylon-renderers/styles/components/ControlCenter.css',
  'src/plugins/product/packages/builtin.pylon-renderers/styles/components/PetCompanion.css',
  'src/plugins/product/packages/builtin.pylon-renderers/styles/components/chat/ChatView.css',
  'src/plugins/product/packages/builtin.pylon-renderers/styles/components/chat/DiffCard.css',
  'src/plugins/product/packages/builtin.pylon-renderers/styles/components/chat/InputBar.css',
  'src/plugins/product/packages/builtin.pylon-renderers/styles/components/chat/MessageSearchBar.css',
  'src/plugins/product/packages/builtin.pylon-renderers/styles/components/chat/StatusBar.css',
  'src/plugins/product/packages/builtin.pylon-renderers/styles/components/solid-workbench/WorkbenchChrome.css',
  'src/plugins/product/packages/builtin.pylon-shell/styles/App.css',
  'src/plugins/product/packages/builtin.pylon-shell/styles/components/PermissionDialog.css',
  'src/plugins/product/packages/builtin.pylon-shell/styles/components/ProfileEditor.css',
  'src/plugins/product/packages/builtin.pylon-shell/styles/components/SessionOwnerRecoveryDialog.css',
  'src/plugins/product/packages/builtin.pylon-shell/styles/components/SessionSettings.css',
  'src/plugins/product/packages/builtin.pylon-shell/styles/components/Settings.css',
  'src/plugins/product/packages/builtin.pylon-shell/styles/components/SettingsCommon.css',
  'src/plugins/product/packages/builtin.pylon-workspace/styles/components/PrismSheet.css',
  'src/plugins/product/packages/builtin.pylon-workspace/styles/components/Sidebar.css',
  'src/plugins/product/packages/builtin.pylon-workspace/styles/components/right-panel/ContextPanel.css',
  'src/plugins/product/packages/builtin.pylon-workspace/styles/sheets/OverviewSheetView.css',
  'src/plugins/product/packages/builtin.pylon-workspace/styles/sheets/RuntimeSheetView.css',
  'src/plugins/product/packages/builtin.pylon-workspace/styles/sheets/browser/BrowserSheet.css',
  'src/plugins/product/packages/builtin.pylon-workspace/styles/sheets/file/FileSheet.css',
  'src/plugins/product/packages/builtin.pylon-workspace/styles/sheets/gateway/GatewaySheet.css',
  'src/plugins/product/packages/builtin.pylon-workspace/styles/sheets/history/HistorySheet.css',
  'src/plugins/product/packages/builtin.pylon-workspace/styles/sheets/search/SearchSheet.css',
  'src/renderers/solid-workbench/smoke/solidWorkbenchSmoke.css',
] as const

describe('first-party CSS ownership inventory', () => {
  it('为当前全部生产/Smoke CSS 建立且只建立一个 owner', () => {
    const paths = FIRST_PARTY_STYLE_OWNERSHIP.map(item => item.path)
    expect([...paths].sort()).toEqual([...expectedCssPaths].sort())
    expect(new Set(paths).size).toBe(paths.length)
  })

  it('每个 CSS 记录至少一个唯一 importer', () => {
    for (const item of FIRST_PARTY_STYLE_OWNERSHIP) {
      expect(item.importers.length, item.path).toBeGreaterThan(0)
      expect(new Set(item.importers).size, item.path).toBe(item.importers.length)
      expect(item.importers.every(path => path.startsWith('src/')), item.path).toBe(true)
    }
  })

  it('Kernel 只持有跨 Application 基线，产品样式归属第一方插件', () => {
    expect(listFirstPartyStylesByOwner('kernel').map(item => item.path)).toEqual([
      'src/index.css',
      'src/components/kernel/SkinPreviewBar.css',
    ])
    expect(listFirstPartyStylesByOwner('builtin.pylon-shell')).toHaveLength(7)
    expect(listFirstPartyStylesByOwner('builtin.pylon-workspace')).toHaveLength(10)
    expect(listFirstPartyStylesByOwner('builtin.pylon-renderers')).toHaveLength(8) // +WorkbenchChrome.css（Solid 壳层过渡态）
  })

  it('产品 CSS 全部进入 PluginScope，Smoke 不进入生产 owner', () => {
    const productStyles = FIRST_PARTY_STYLE_OWNERSHIP.filter(item => item.owner.startsWith('builtin.'))
    expect(productStyles.every(item => item.lifecycle === 'plugin-scope')).toBe(true)
    expect(productStyles.every(item => item.path.includes('/packages/'))).toBe(true)
    expect(listFirstPartyStylesByOwner('solid-smoke')).toEqual([
      expect.objectContaining({
        path: 'src/renderers/solid-workbench/smoke/solidWorkbenchSmoke.css',
        lifecycle: 'smoke-only',
      }),
    ])
  })
})
