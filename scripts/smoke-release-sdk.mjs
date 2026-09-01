// 发行包 SDK 端到端冒烟：纯 JS 插件（无构建、无 node_modules）相对 import 发行 SDK
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const pluginDir = join(tmpdir(), 'pylon-sdk-e2e', 'my-plugin')
const mod = await import(pathToFileURL(join(pluginDir, 'index.js')))
const sdk = await import(pathToFileURL(join(process.cwd(), 'src-tauri', 'resources', 'sdk', 'pylon-plugin-sdk.js')))

console.log('plugin entry default.activate is function:', typeof mod.default.activate === 'function')
console.log('sdk exports complete:',
  ['definePlugin', 'createSettingsSurface', 'createPluginLogger', 'VISUAL_SEMANTIC_TOKENS', 'PYLON_PLUGIN_API_SUPPORTED']
    .every(key => key in sdk))
console.log('supported api:', sdk.PYLON_PLUGIN_API_SUPPORTED.join('/'))

// 假宿主激活一遍，验证 SDK helpers 在 bundle 里可用
const ctx = {
  identity: { pluginId: 'user.first' },
  commands: { register: () => {} },
  scope: { setInterval() {}, listen() {} },
}
await mod.default.activate(ctx)
console.log('activate ran clean under a minimal host-shaped context')
