export const FIRST_PARTY_STYLE_OWNERS = [
  'kernel',
  'builtin.pylon-shell',
  'builtin.pylon-workspace',
  'builtin.pylon-renderers',
  'solid-smoke',
] as const

export type FirstPartyStyleOwner = typeof FIRST_PARTY_STYLE_OWNERS[number]

export const FIRST_PARTY_STYLE_LIFECYCLES = [
  'kernel-static',
  'plugin-scope',
  'smoke-only',
] as const

export type FirstPartyStyleLifecycle = typeof FIRST_PARTY_STYLE_LIFECYCLES[number]

export interface FirstPartyStyleOwnershipEntry {
  readonly path: string
  readonly owner: FirstPartyStyleOwner
  readonly lifecycle: FirstPartyStyleLifecycle
  readonly importers: readonly string[]
  readonly note?: string
}

const entry = (
  path: string,
  owner: FirstPartyStyleOwner,
  lifecycle: FirstPartyStyleLifecycle,
  importers: readonly string[],
  note?: string,
): FirstPartyStyleOwnershipEntry => Object.freeze({
  path,
  owner,
  lifecycle,
  importers: Object.freeze([...importers]),
  ...(note ? { note } : {}),
})

const SHELL_STYLE_ASSETS = 'src/plugins/product/packages/builtin.pylon-shell/styleAssets.ts'
const WORKSPACE_STYLE_ASSETS = 'src/plugins/product/packages/builtin.pylon-workspace/styleAssets.ts'
const RENDERER_STYLE_ASSETS = 'src/plugins/product/packages/builtin.pylon-renderers/styleAssets.ts'

/**
 * 第一方 CSS 的唯一 ownership 真值。
 *
 * Kernel 继续由入口静态持有 Recovery 所需基线；产品 CSS 已迁入对应第一方包，
 * 只由 styleAssets `?inline` 读取，并在插件激活时交给 PluginScope 挂载和回收。
 */
export const FIRST_PARTY_STYLE_OWNERSHIP: readonly FirstPartyStyleOwnershipEntry[] = Object.freeze([
  entry('src/index.css', 'kernel', 'kernel-static', ['src/main.tsx'], 'React Root、基础 token、跨 Application scheme 与 Recovery 基线'),
  entry('src/components/kernel/SkinPreviewBar.css', 'kernel', 'kernel-static', ['src/components/kernel/SkinPreviewBar.tsx']),

  entry('src/plugins/product/packages/builtin.pylon-shell/styles/App.css', 'builtin.pylon-shell', 'plugin-scope', [SHELL_STYLE_ASSETS]),
  entry('src/plugins/product/packages/builtin.pylon-shell/styles/components/PermissionDialog.css', 'builtin.pylon-shell', 'plugin-scope', [SHELL_STYLE_ASSETS]),
  entry('src/plugins/product/packages/builtin.pylon-shell/styles/components/ProfileEditor.css', 'builtin.pylon-shell', 'plugin-scope', [SHELL_STYLE_ASSETS]),
  entry('src/plugins/product/packages/builtin.pylon-shell/styles/components/SessionOwnerRecoveryDialog.css', 'builtin.pylon-shell', 'plugin-scope', [SHELL_STYLE_ASSETS]),
  entry('src/plugins/product/packages/builtin.pylon-shell/styles/components/SessionSettings.css', 'builtin.pylon-shell', 'plugin-scope', [SHELL_STYLE_ASSETS]),
  entry('src/plugins/product/packages/builtin.pylon-shell/styles/components/Settings.css', 'builtin.pylon-shell', 'plugin-scope', [SHELL_STYLE_ASSETS]),
  entry('src/plugins/product/packages/builtin.pylon-shell/styles/components/SettingsCommon.css', 'builtin.pylon-shell', 'plugin-scope', [SHELL_STYLE_ASSETS]),

  entry('src/plugins/product/packages/builtin.pylon-workspace/styles/components/PrismSheet.css', 'builtin.pylon-workspace', 'plugin-scope', [WORKSPACE_STYLE_ASSETS]),
  entry('src/plugins/product/packages/builtin.pylon-workspace/styles/components/Sidebar.css', 'builtin.pylon-workspace', 'plugin-scope', [WORKSPACE_STYLE_ASSETS]),
  entry('src/plugins/product/packages/builtin.pylon-workspace/styles/components/right-panel/ContextPanel.css', 'builtin.pylon-workspace', 'plugin-scope', [WORKSPACE_STYLE_ASSETS]),
  entry('src/plugins/product/packages/builtin.pylon-workspace/styles/sheets/OverviewSheetView.css', 'builtin.pylon-workspace', 'plugin-scope', [WORKSPACE_STYLE_ASSETS]),
  entry('src/plugins/product/packages/builtin.pylon-workspace/styles/sheets/RuntimeSheetView.css', 'builtin.pylon-workspace', 'plugin-scope', [WORKSPACE_STYLE_ASSETS]),
  entry('src/plugins/product/packages/builtin.pylon-workspace/styles/sheets/browser/BrowserSheet.css', 'builtin.pylon-workspace', 'plugin-scope', [WORKSPACE_STYLE_ASSETS]),
  entry('src/plugins/product/packages/builtin.pylon-workspace/styles/sheets/file/FileSheet.css', 'builtin.pylon-workspace', 'plugin-scope', [WORKSPACE_STYLE_ASSETS]),
  entry('src/plugins/product/packages/builtin.pylon-workspace/styles/sheets/gateway/GatewaySheet.css', 'builtin.pylon-workspace', 'plugin-scope', [WORKSPACE_STYLE_ASSETS]),
  entry('src/plugins/product/packages/builtin.pylon-workspace/styles/sheets/history/HistorySheet.css', 'builtin.pylon-workspace', 'plugin-scope', [WORKSPACE_STYLE_ASSETS]),
  entry('src/plugins/product/packages/builtin.pylon-workspace/styles/sheets/search/SearchSheet.css', 'builtin.pylon-workspace', 'plugin-scope', [WORKSPACE_STYLE_ASSETS]),

  entry('src/plugins/product/packages/builtin.pylon-renderers/styles/components/chat/ChatView.css', 'builtin.pylon-renderers', 'plugin-scope', [RENDERER_STYLE_ASSETS]),
  entry('src/plugins/product/packages/builtin.pylon-renderers/styles/components/chat/DiffCard.css', 'builtin.pylon-renderers', 'plugin-scope', [RENDERER_STYLE_ASSETS]),
  entry('src/plugins/product/packages/builtin.pylon-renderers/styles/components/chat/InputBar.css', 'builtin.pylon-renderers', 'plugin-scope', [RENDERER_STYLE_ASSETS]),
  entry('src/plugins/product/packages/builtin.pylon-renderers/styles/components/chat/MessageSearchBar.css', 'builtin.pylon-renderers', 'plugin-scope', [RENDERER_STYLE_ASSETS]),
  entry('src/plugins/product/packages/builtin.pylon-renderers/styles/components/chat/StatusBar.css', 'builtin.pylon-renderers', 'plugin-scope', [RENDERER_STYLE_ASSETS]),
  entry('src/plugins/product/packages/builtin.pylon-renderers/styles/components/ControlCenter.css', 'builtin.pylon-renderers', 'plugin-scope', [RENDERER_STYLE_ASSETS]),
  entry('src/plugins/product/packages/builtin.pylon-renderers/styles/components/PetCompanion.css', 'builtin.pylon-renderers', 'plugin-scope', [RENDERER_STYLE_ASSETS]),

  entry('src/renderers/solid-workbench/smoke/solidWorkbenchSmoke.css', 'solid-smoke', 'smoke-only', [
    'src/renderers/solid-workbench/smoke/browserSmoke.solid.tsx',
    'src/renderers/solid-workbench/smoke/mountSolidWorkbenchSmoke.solid.tsx',
  ]),
])

export function listFirstPartyStylesByOwner(owner: FirstPartyStyleOwner): readonly FirstPartyStyleOwnershipEntry[] {
  return FIRST_PARTY_STYLE_OWNERSHIP.filter(item => item.owner === owner)
}
