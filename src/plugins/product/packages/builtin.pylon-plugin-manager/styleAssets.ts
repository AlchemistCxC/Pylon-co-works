import type { FirstPartyStyleAsset } from '../../firstPartyStyleRuntime.ts'

const styleModules = typeof document === 'undefined'
  ? {}
  : import.meta.glob<string>([
  './panel/pluginManagerPanel.css',
], { query: '?inline', import: 'default', eager: true })

export function loadBuiltinPluginManagerStyles(): readonly FirstPartyStyleAsset[] {
  return Object.freeze(Object.entries(styleModules).map(([path, css]) => ({ path, css })))
}
