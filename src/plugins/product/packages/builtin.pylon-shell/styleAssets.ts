import type { FirstPartyStyleAsset } from '../../firstPartyStyleRuntime.ts'

const styleModules = typeof document === 'undefined'
  ? {}
  : import.meta.glob<string>([
  './styles/App.css',
  './styles/components/PermissionDialog.css',
  './styles/components/ProfileEditor.css',
  './styles/components/SessionOwnerRecoveryDialog.css',
  './styles/components/SessionSettings.css',
  './styles/components/Settings.css',
  './styles/components/SettingsCommon.css',
], { query: '?inline', import: 'default', eager: true })

export function loadBuiltinPylonShellStyles(): readonly FirstPartyStyleAsset[] {
  return Object.freeze(Object.entries(styleModules).map(([path, css]) => ({ path, css })))
}
