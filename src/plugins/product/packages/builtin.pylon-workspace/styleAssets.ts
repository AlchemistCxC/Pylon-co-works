import type { FirstPartyStyleAsset } from '../../firstPartyStyleRuntime.ts'

const styleModules = typeof document === 'undefined'
  ? {}
  : import.meta.glob<string>([
  './styles/adaptive.css',
  './styles/components/PrismSheet.css',
  './styles/components/Sidebar.css',
  './styles/components/right-panel/ContextPanel.css',
  './styles/sheets/OverviewSheetView.css',
  './styles/sheets/RuntimeSheetView.css',
  './styles/sheets/file/FileSheet.css',
], { query: '?inline', import: 'default', eager: true })

export function loadBuiltinPylonWorkspaceStyles(): readonly FirstPartyStyleAsset[] {
  return Object.freeze(Object.entries(styleModules).map(([path, css]) => ({ path, css })))
}
