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
      // C3 门控：management 属性仅在声明 ∧ 授权时存在；未授权时面板呈现授权引导。
      // 持有者标记（review P1-1）：parallel 热替换时新实例先 activate、旧实例后
      // deactivate，清除必须按持有者判定——本实例的装配只允许本实例的 scope
      // dispose（= 本实例停用）清掉，旧实例不得清掉新实例的装配。
      pluginManagerRuntimeBridge.setManagement(management, identity.key)
      scope.add(() => pluginManagerRuntimeBridge.clearManagement(identity.key), {
        resourceId: `${BUILTIN_PYLON_PLUGIN_MANAGER_ID}:bridge-owner`,
      })
      settings.registerPage({
        id: 'pylon-plugin-manager',
        label: '插件管理器（增强）',
        description: '以插件身份提供的增强插件管理面板：安装/启停/重载/卸载、契约诊断与贡献面透视。',
        renderKind: 'first-party-react',
        component: ManagerSettingsPage,
      } as const)
    },
    deactivate: () => {
      // 资源回收由 scope 登记（上方 bridge-owner）承载；此处无需额外动作
    },
  }
}

export default defineFirstPartyProductPackage(
  manifestSource,
  import.meta.url,
  createBuiltinPluginManagerPlugin,
)
