/**
 * 插件开发套件自检（node verify.mjs，需 Node ≥ 18）。
 * 校验：目录结构完整 → SDK bundle 可 import 且导出完整 → SDK 版本常量 →
 * 起步插件入口可解析 → 类型树关键声明存在。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const scriptRoot = dirname(fileURLToPath(import.meta.url))
// 该文件既可直接从仓库执行，也会被复制到生成套件根目录。
// 仓库位置没有 sibling sdk，回退到最近一次生成的套件；复制后则使用自身目录。
const kitRoot = existsSync(join(scriptRoot, 'sdk'))
  ? scriptRoot
  : join(scriptRoot, '..', 'dist-plugin-devkit', 'pylon-plugin-devkit')
const results = []
const check = (name, ok, detail = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`)

// 1. 结构
const required = [
  'sdk/pylon-plugin-sdk.js',
  'sdk/testing.js',
  'sdk/package.json',
  'sdk/pylon-plugin-manifest.schema.json',
  'sdk/types/sdk/index.d.ts',
  'sdk/types/sdk/testing.d.ts',
  'starter/no-build/pylon-plugin.json',
  'starter/no-build/index.js',
  'starter/typescript/dist/index.js',
  'starter/manager-demo/pylon-plugin.json',
  'starter/manager-demo/dist/index.js',
  'starter/manager-demo/styles/panel.css',
  'docs/Pylon-插件系统说明书-开发者版.md',
  'docs/Pylon-发行包清单.md',
  'README.md',
]
for (const rel of required) check(`结构 ${rel}`, existsSync(join(kitRoot, rel)))

// 2. SDK bundle 导出与版本
const sdk = await import(pathToFileURL(join(kitRoot, 'sdk', 'pylon-plugin-sdk.js')))
check('SDK 导出完整', ['definePlugin', 'createSettingsSurface', 'createPluginLogger', 'VISUAL_SEMANTIC_TOKENS']
  .every(key => key in sdk))
// 期望值从随包的 manifest schema 推导，不写死——写死会在每次 API 升 minor 后失真
// （旧写法固定 '1.0/1.1/1.2'，宿主早已到 2.x 却无人发现，因为它不在任何门禁链上）。
const schemaApiVersions = JSON.parse(readFileSync(join(kitRoot, 'sdk', 'pylon-plugin-manifest.schema.json'), 'utf8'))
  .properties.api.enum
check('SDK 版本 allowlist 与 manifest schema 一致',
  sdk.PYLON_PLUGIN_API_SUPPORTED.join('/') === schemaApiVersions.join('/'))
check('SDK 版本 allowlist 覆盖到最新版',
  sdk.PYLON_PLUGIN_API_SUPPORTED.includes(sdk.PYLON_PLUGIN_API_LATEST))
check('SDK 能力词表导出', Array.isArray(sdk.PYLON_PLUGIN_CAPABILITIES)
  && sdk.PYLON_PLUGIN_CAPABILITIES.includes('plugin.management'))

// 3. SDK 包清单 types 指向存在
const pkg = JSON.parse(readFileSync(join(kitRoot, 'sdk', 'package.json'), 'utf8'))
check('types 入口存在', existsSync(join(kitRoot, 'sdk', pkg.types)))
const packageExports = pkg.exports ?? {}
check('根入口 exports 完整',
  packageExports['.']?.default === './pylon-plugin-sdk.js'
  && packageExports['.']?.types === './types/sdk/index.d.ts'
  && existsSync(join(kitRoot, 'sdk', packageExports['.'].default)))
check('testing 子路径 exports 完整',
  packageExports['./testing']?.default === './testing.js'
  && packageExports['./testing']?.types === './types/sdk/testing.d.ts'
  && existsSync(join(kitRoot, 'sdk', packageExports['./testing'].default))
  && existsSync(join(kitRoot, 'sdk', packageExports['./testing'].types)))

// 4. 起步插件 manifest 可解析
const manifest = JSON.parse(readFileSync(join(kitRoot, 'starter/no-build/pylon-plugin.json'), 'utf8'))
check('no-build manifest 合法', manifest.schema === 1 && manifest.api === '1.1')

// 4.1 外置管理器示例（P53 D4）：api 1.2 + capability 声明 + 预构建入口
const managerManifest = JSON.parse(readFileSync(join(kitRoot, 'starter/manager-demo/pylon-plugin.json'), 'utf8'))
check('manager-demo manifest 合法', managerManifest.schema === 1
  && managerManifest.api === '1.2'
  && Array.isArray(managerManifest.capabilities)
  && managerManifest.capabilities.includes('plugin.management'))
check('manager-demo 入口 bundle 含激活导出',
  readFileSync(join(kitRoot, 'starter/manager-demo/dist/index.js'), 'utf8').includes('activate'))

// 5. 类型树关键声明存在。SDK 分层后（contract/runtime 子声明文件 + index 的
//    export * 组合），符号不再集中在 index.d.ts——搜类型树顶层全部声明文件，
//    不绑定单一文件布局。
const typeTreeDir = join(kitRoot, 'sdk', 'types', 'sdk')
const typeTree = readdirSync(typeTreeDir)
  .filter(name => name.endsWith('.d.ts'))
  .map(name => readFileSync(join(typeTreeDir, name), 'utf8'))
  .join('\n')
check('类型树含 createSettingsSurface', typeTree.includes('createSettingsSurface'))
check('类型树含 defineManifest', typeTree.includes('defineManifest'))
check('类型树含隔离面协议类型 AgentSidebarSurfaceInput', typeTree.includes('AgentSidebarSurfaceInput'))
check('类型树含 2.x 面类型 CommandTitlebarContribution 与 PresetContribution',
  typeTree.includes('CommandTitlebarContribution') && typeTree.includes('PresetContribution'))
const testingDts = readFileSync(join(kitRoot, 'sdk', 'types', 'sdk', 'testing.d.ts'), 'utf8')
check('testing 类型树含 createMockContext', testingDts.includes('createMockContext'))

console.log(results.join('\n'))
if (results.some(line => line.startsWith('FAIL'))) process.exit(1)
console.log('verify: ALL PASS')
