import { afterAll, beforeAll, test } from 'vitest'
import { createPluginIdentity } from '../src/plugin-runtime/pluginIdentity.ts'
import { activateBuiltinPlugin, getPluginRuntime } from '../src/plugin-runtime/pluginCompositionRoot.ts'
import { BUILTIN_WORKSPACE_TYPES } from '../src/plugins/core/sheet/builtinWorkspacePlugins.ts'
import {
  BUILTIN_PYLON_GATEWAY_ID,
  BUILTIN_PYLON_RENDERERS_ID,
  BUILTIN_PYLON_TOOLS_ID,
} from '../src/plugins/product/productPluginIds.ts'
import { getWorkspaceRegistryStore } from '../src/workspace-sheets/workspaceRegistry.ts'

const legacyScripts = [
  { name: 'test-session-runtime.mts', load: () => import('./test-session-runtime.mts') },
  { name: 'test-sheet-persistence-v2.mts', load: () => import('./test-sheet-persistence-v2.mts') },
  { name: 'test-tool-presentation-model.mts', load: () => import('./test-tool-presentation-model.mts') },
  { name: 'test-sheet-registry.mts', load: () => import('./test-sheet-registry.mts') },
  { name: 'test-tool-renderer-registry.mts', load: () => import('./test-tool-renderer-registry.mts') },
  { name: 'test-sheet-state.mts', load: () => import('./test-sheet-state.mts') },
] as const

const registrations: Array<{ dispose(): void }> = []
const activatedRuntimeKeys: string[] = []

beforeAll(async () => {
  const runtime = getPluginRuntime()
  // P77：gateway 由第 7 包 builtin.pylon-gateway 贡献（core BUILTIN_WORKSPACE_TYPES 已摘除），
  // 因此本 runner 必须显式激活它，否则注册表只有 core 的 8 个 kind。
  for (const pluginId of [BUILTIN_PYLON_TOOLS_ID, BUILTIN_PYLON_RENDERERS_ID, BUILTIN_PYLON_GATEWAY_ID]) {
    const existing = runtime.snapshot().active.find(identity => identity.pluginId === pluginId)
    if (existing) continue
    await activateBuiltinPlugin(pluginId)
    const activated = runtime.snapshot().active.find(identity => identity.pluginId === pluginId)
    if (activated) activatedRuntimeKeys.push(activated.key)
  }

  const registry = getWorkspaceRegistryStore()
  const owner = createPluginIdentity('test.legacy-plugin-runtime', 'runtime')
  for (const workspace of BUILTIN_WORKSPACE_TYPES) {
    if (!registry.resolve(workspace.kind)) registrations.push(registry.register(owner, workspace))
  }
})

afterAll(async () => {
  for (const registration of registrations.reverse()) registration.dispose()
  const runtime = getPluginRuntime()
  for (const runtimeKey of activatedRuntimeKeys.reverse()) await runtime.deactivate(runtimeKey)
})

for (const script of legacyScripts) {
  test(script.name, async () => {
    await script.load()
  })
}
