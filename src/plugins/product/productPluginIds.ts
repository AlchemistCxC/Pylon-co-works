export const BUILTIN_PYLON_SHELL_ID = 'builtin.pylon-shell'
export const BUILTIN_PYLON_WORKSPACE_ID = 'builtin.pylon-workspace'
export const BUILTIN_PYLON_RENDERERS_ID = 'builtin.pylon-renderers'
export const BUILTIN_PYLON_AGENT_ADAPTERS_ID = 'builtin.pylon-agent-adapters'
export const BUILTIN_PYLON_TOOLS_ID = 'builtin.pylon-tools'
export const BUILTIN_PYLON_PLUGIN_MANAGER_ID = 'builtin.pylon-plugin-manager'
export const BUILTIN_PYLON_GATEWAY_ID = 'builtin.pylon-gateway'

/**
 * 插件管理器设置页 id（settings.registerPage 的页面命名空间，无 `builtin.` 前缀；
 * 与插件 id BUILTIN_PYLON_PLUGIN_MANAGER_ID 分属两根轴）。宿主「插件管理」分区
 * 托管该页时以 settingsDomains 的 HOSTED_PLUGIN_MANAGER_PAGE_ID（值相等）对齐。
 */
export const BUILTIN_PLUGIN_MANAGER_PAGE_ID = 'pylon-plugin-manager'

export const BUILTIN_PYLON_PRODUCT_PLUGIN_IDS = Object.freeze([
  BUILTIN_PYLON_SHELL_ID,
  BUILTIN_PYLON_WORKSPACE_ID,
  BUILTIN_PYLON_RENDERERS_ID,
  BUILTIN_PYLON_AGENT_ADAPTERS_ID,
  BUILTIN_PYLON_TOOLS_ID,
  BUILTIN_PYLON_PLUGIN_MANAGER_ID,
  BUILTIN_PYLON_GATEWAY_ID,
] as const)
