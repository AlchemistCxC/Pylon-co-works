import { strict as assert } from 'node:assert'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
// This file is also executed by the strip-only Node legacy runner.  Consume
// the shared manifest schema here instead of importing the runtime parser
// (which intentionally uses richer TypeScript syntax) so the guard remains
// executable in both Node and Vitest.
const manifestSchema = JSON.parse(readFileSync(join(root, 'shared/pylon-plugin-manifest.schema.json'), 'utf8')) as {
  properties?: { api?: { enum?: unknown[] } }
}
const supportedPluginApiVersions = manifestSchema.properties?.api?.enum
  ?.filter((value): value is string => typeof value === 'string') ?? []
assert.ok(supportedPluginApiVersions.length > 0, 'manifest schema 必须声明 Plugin API allowlist')
const forbidden = [
  'src/contracts/plugin.ts',
  'src/host/pluginRegistry.ts',
  'src/host/pluginHost.ts',
  'src/host/extensionPoint.ts',
  'src/host/capabilityBroker.ts',
  'src/host/pluginCompositionRoot.ts',
  'src/application/plugins/pluginInstallationService.ts',
  'src/infrastructure/plugins/pluginDirectoryClient.ts',
  'scripts/plugin-cli.mts',
  'scripts/plugin-cli-smoke.test.mts',
  'src/plugin-runtime-v2',
]
for (const relative of forbidden) {
  assert.equal(existsSync(join(root, relative)), false, `旧插件路径必须删除：${relative}`)
}
assert.equal(existsSync(join(root, 'src/plugin-runtime')), true, '统一插件运行时目录缺失')

const walk = (directory: string): string[] => readdirSync(directory)
  .flatMap(name => {
    const path = join(directory, name)
    return statSync(path).isDirectory() ? walk(path) : [path]
  })

for (const base of ['examples', 'src/plugins/product/packages']) {
  for (const path of walk(join(root, base)).filter(path => path.endsWith('pylon-plugin.json'))) {
    const manifest = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    assert.equal(manifest.schema, 1, `${path} 必须使用 schema 1`)
    assert.ok(
      typeof manifest.api === 'string'
        && supportedPluginApiVersions.includes(manifest.api),
      `${path} 必须使用受支持的 Plugin API（${supportedPluginApiVersions.join('/')}）`,
    )
    assert.equal(typeof (manifest.web as { entry?: unknown } | undefined)?.entry, 'string', `${path} 必须声明 web.entry`)
    for (const deleted of ['trust', 'capabilities', 'contributes', 'signature', 'entry']) {
      assert.equal(deleted in manifest, false, `${path} 不得保留旧字段 ${deleted}`)
    }
  }
}

const nativeCommands = readFileSync(join(root, 'src-tauri/src/lib.rs'), 'utf8')
const nativeStore = readFileSync(join(root, 'src-tauri/src/plugin_cmds.rs'), 'utf8')
for (const command of [
  'plugin_state_get', 'plugin_state_set', 'plugin_list_installed',
  'plugin_read_installed', 'plugin_read_source', 'plugin_install', 'plugin_uninstall',
]) {
  assert.doesNotMatch(nativeCommands, new RegExp(`\\b${command}\\b`), `旧命令仍在注册：${command}`)
  assert.doesNotMatch(nativeStore, new RegExp(`fn\\s+${command}\\b`), `旧命令实现仍存在：${command}`)
}

const pluginManager = readFileSync(join(root, 'src/components/settings/PluginManager.tsx'), 'utf8')
assert.doesNotMatch(pluginManager, /PluginRegistry|PluginHost|api=0\.1|devMode|paste/i)
assert.match(pluginManager, /Pylon Plugin API \{PYLON_PLUGIN_API_VERSION\}/)

console.log('插件 API allowlist 与旧运行时删除守卫通过')
