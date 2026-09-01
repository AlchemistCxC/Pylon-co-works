/**
 * 插件开发套件自检（node verify.mjs，需 Node ≥ 18）。
 * 校验：目录结构完整 → SDK bundle 可 import 且导出完整 → SDK 版本常量 →
 * 起步插件入口可解析 → 类型树关键声明存在。
 */
import { existsSync, readFileSync } from 'node:fs'
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
  'docs/Pylon-插件系统说明书-开发者版.md',
  'docs/Pylon-发行包清单.md',
  'README.md',
]
for (const rel of required) check(`结构 ${rel}`, existsSync(join(kitRoot, rel)))

// 2. SDK bundle 导出与版本
const sdk = await import(pathToFileURL(join(kitRoot, 'sdk', 'pylon-plugin-sdk.js')))
check('SDK 导出完整', ['definePlugin', 'createSettingsSurface', 'createPluginLogger', 'VISUAL_SEMANTIC_TOKENS']
  .every(key => key in sdk))
check('SDK 版本 allowlist', sdk.PYLON_PLUGIN_API_SUPPORTED.join('/') === '1.0/1.1')

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

// 5. 类型树声明了 createSettingsSurface
const indexDts = readFileSync(join(kitRoot, 'sdk', 'types', 'sdk', 'index.d.ts'), 'utf8')
check('类型树含 createSettingsSurface', indexDts.includes('createSettingsSurface'))
const testingDts = readFileSync(join(kitRoot, 'sdk', 'types', 'sdk', 'testing.d.ts'), 'utf8')
check('testing 类型树含 createMockContext', testingDts.includes('createMockContext'))

console.log(results.join('\n'))
if (results.some(line => line.startsWith('FAIL'))) process.exit(1)
console.log('verify: ALL PASS')
