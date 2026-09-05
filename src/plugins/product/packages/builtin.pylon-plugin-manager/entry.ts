import { lazy } from 'react'
import manifestSource from './pylon-plugin.json' with { type: 'json' }
import type { BuiltinPluginDefinition } from '../../../../plugin-runtime/pluginRuntime.ts'
import type { BuiltinPluginActivationContext } from '../../../../plugin-runtime/pluginActivationContext.ts'
import { defineFirstPartyProductPackage } from '../../firstPartyProductPackage.ts'
import { BUILTIN_PYLON_PLUGIN_MANAGER_ID } from '../../productPluginIds.ts'
import { mountFirstPartyStyleAssets } from '../../firstPartyStyleRuntime.ts'
import { loadBuiltinPluginManagerStyles } from './styleAssets.ts'
import { pluginManagerRuntimeBridge } from './runtimeBridge.ts'

const ManagerSettingsPage = lazy(() => import('./ManagerSettingsPage.tsx'))

export function createBuiltinPluginManagerPlugin(): BuiltinPluginDefinition {
  return {
    id: BUILTIN_PYLON_PLUGIN_MANAGER_ID,
    kind: 'feature',
    firstParty: true,
    hotSwapMode: 'parallel',
    activate: ({ settings, identity, scope, management }: BuiltinPluginActivationContext) => {
      mountFirstPartyStyleAssets(
        BUILTIN_PYLON_PLUGIN_MANAGER_ID,
        identity.key,
        scope,
        loadBuiltinPluginManagerStyles(),
      )
      // C3 门控：management 属性仅在声明 ∧ 授权时存在；未授权时面板呈现授权引导
      pluginManagerRuntimeBridge.setManagement(management)
      settings.registerPage({
        id: 'pylon-plugin-manager',
        label: '插件管理器（增强）',
        description: '以插件身份提供的增强插件管理面板：安装/启停/重载/卸载、契约诊断与贡献面透视。',
        renderKind: 'first-party-react',
        component: ManagerSettingsPage,
      } as const)
    },
    deactivate: () => {
      pluginManagerRuntimeBridge.setManagement(undefined)
    },
  }
}

export default defineFirstPartyProductPackage(
  manifestSource,
  import.meta.url,
  createBuiltinPluginManagerPlugin,
)
