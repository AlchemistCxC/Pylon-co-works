import type { FirstPartyStyleAsset } from '../../firstPartyStyleRuntime.ts'

// J 施工书 20260914：pluginManagerPanel.css 已绞杀进 kernel utilities 层
// （src/styles/tailwind.css），本包暂无自有样式资产。机制保留：新增 CSS
// 时恢复 import.meta.glob 并在 firstPartyStyleOwnership.ts 登记条目。
export function loadBuiltinPluginManagerStyles(): readonly FirstPartyStyleAsset[] {
  return Object.freeze([])
}
