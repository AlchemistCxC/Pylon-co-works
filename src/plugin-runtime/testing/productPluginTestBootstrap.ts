import { beforeAll } from 'vitest'
import { bootstrapBuiltins } from '../pluginCompositionRoot.ts'
import { getPluginCapabilityGrantStore } from '../management/pluginManagementWiring.ts'
import { BUILTIN_PYLON_PLUGIN_MANAGER_ID } from '../../plugins/product/productPluginIds.ts'
import { loadFirstPartyProductPackages } from '../../plugins/product/builtinProductPlugins.ts'

/** 授权记录按 (pluginVersion, apiVersion) 校验；从包 manifest 取真值，避免魔数漂移。 */
function managerGrantIdentity(): { pluginVersion: string; apiVersion: string } {
  const manager = loadFirstPartyProductPackages()
    .find(pkg => pkg.manifest.id === BUILTIN_PYLON_PLUGIN_MANAGER_ID)
  if (!manager) throw new Error(`第一方包缺少 ${BUILTIN_PYLON_PLUGIN_MANAGER_ID}`)
  return { pluginVersion: manager.manifest.version, apiVersion: manager.manifest.api }
}

/** Explicit opt-in for tests that consume first-party product contributions. */
beforeAll(async () => {
  // 产品 bootstrap 有意把声明 capability 的插件停在 await-consent；导入本 helper 的
  // 测试即声明需要完整第一方面，故先补宿主侧授权（与宿主授权卡同一条 grant 路径）。
  getPluginCapabilityGrantStore().grant(
    BUILTIN_PYLON_PLUGIN_MANAGER_ID,
    'plugin.management',
    managerGrantIdentity(),
  )
  const result = await bootstrapBuiltins('normal')
  if (result.failures.length > 0) {
    throw new Error(`Product plugin test bootstrap failed: ${result.failures.map(item => `${item.pluginId}: ${item.message}`).join('; ')}`)
  }
})
