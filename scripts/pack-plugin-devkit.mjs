/**
 * pack-plugin-devkit.mjs — 组装离线插件开发套件（部署包）。
 *
 * 目标：拿到套件的人只需 部署-解压-阅读 README 就能开始插件开发，
 * 不需要 prism-desktop 源码仓库。
 *
 * 产物 dist-plugin-devkit/pylon-plugin-devkit/：
 * - sdk/                 @pylon/plugin-sdk 本地包（运行时 ESM + 类型树 + testing + schema）
 * - starter/no-build/    纯 JS 无构建起步插件（零工具链）
 * - starter/typescript/  TS + esbuild 起步插件（含预构建 dist）
 * - docs/                开发者版/用户版说明书 + CLI 命令表 + 设置选项贡献
 * - verify.mjs           自检脚本（结构 + 导出 + 类型探针）
 *
 * 质量门（失败即退出非零）：
 * G1 SDK bundle 导出完整；G2 类型探针（严格模式消费者 tsc --noEmit 通过）。
 */
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const kitRoot = join(repoRoot, 'dist-plugin-devkit', 'pylon-plugin-devkit')
const sdkOut = join(kitRoot, 'sdk')

rmSync(kitRoot, { recursive: true, force: true })
mkdirSync(sdkOut, { recursive: true })

// ── sdk：构建脚本是唯一真源；devkit 只消费正常版 ──
execFileSync(process.execPath, [join(repoRoot, 'scripts', 'build-plugin-sdk.mjs')], {
  cwd: repoRoot,
  stdio: 'inherit',
})
cpSync(join(repoRoot, 'dist-plugin-sdk', 'normal'), sdkOut, { recursive: true })

// ── starter/no-build：零工具链 ──
const noBuild = join(kitRoot, 'starter', 'no-build')
mkdirSync(noBuild, { recursive: true })
cpSync(join(sdkOut, 'pylon-plugin-sdk.js'), join(noBuild, 'pylon-plugin-sdk.js'))
writeFileSync(join(noBuild, 'pylon-plugin.json'), JSON.stringify({
  $schema: '../../sdk/pylon-plugin-manifest.schema.json',
  schema: 1, id: 'starter.plain', name: 'Starter Plain', version: '1.0.0',
  api: '1.1', kind: 'feature',
  web: { entry: './index.js', styles: ['./styles/main.css'] },
  dependencies: {}, optionalDependencies: {}, conflicts: [],
  activation: { events: ['kernel.ready'] },
  hotSwap: { mode: 'parallel', drainTimeoutMs: 5000 },
}, null, 2))
writeFileSync(join(noBuild, 'index.js'), readFileSync(join(repoRoot, 'examples', 'web-plugins', 'hello-starter', 'src', 'index.ts'), 'utf8')
  .replace("from '@pylon/plugin-sdk'", "from './pylon-plugin-sdk.js'"))
cpSync(join(repoRoot, 'examples', 'web-plugins', 'hello-starter', 'styles'), join(noBuild, 'styles'), { recursive: true })

// ── starter/typescript：预构建 dist + 可改源码 ──
const tsStarter = join(kitRoot, 'starter', 'typescript')
mkdirSync(tsStarter, { recursive: true })
cpSync(join(repoRoot, 'examples', 'web-plugins', 'hello-starter', 'src'), join(tsStarter, 'src'), { recursive: true })
cpSync(join(repoRoot, 'examples', 'web-plugins', 'hello-starter', 'styles'), join(tsStarter, 'styles'), { recursive: true })
cpSync(join(repoRoot, 'examples', 'web-plugins', 'hello-starter', 'dist'), join(tsStarter, 'dist'), { recursive: true })
writeFileSync(join(tsStarter, 'pylon-plugin.json'), JSON.stringify({
  $schema: '../../sdk/pylon-plugin-manifest.schema.json',
  schema: 1, id: 'starter.hello', name: 'Starter Hello', version: '1.0.0',
  api: '1.1', kind: 'feature',
  web: { entry: './dist/index.js', styles: ['./styles/main.css'] },
  dependencies: {}, optionalDependencies: {}, conflicts: [],
  activation: { events: ['kernel.ready'] },
  hotSwap: { mode: 'parallel', drainTimeoutMs: 5000 },
}, null, 2))
writeFileSync(join(tsStarter, 'package.json'), JSON.stringify({
  name: 'starter-hello', private: true, type: 'module',
  scripts: {
    build: 'esbuild src/index.ts --bundle --format=esm --platform=browser --alias:@pylon/plugin-sdk=../sdk/pylon-plugin-sdk.js --outfile=dist/index.js',
  },
  devDependencies: { esbuild: '^0.24.0' },
}, null, 2))
writeFileSync(join(tsStarter, 'tsconfig.json'), JSON.stringify({
  compilerOptions: {
    strict: true, noEmit: true, target: 'ES2021', module: 'ESNext',
    moduleResolution: 'bundler', lib: ['ES2022', 'DOM', 'DOM.Iterable'],
    skipLibCheck: true, allowImportingTsExtensions: true, isolatedModules: true,
    baseUrl: '.',
    paths: { '@pylon/plugin-sdk': ['../../sdk/types/sdk/index.d.ts'] },
  },
  include: ['src', '../../sdk/types/sdk/index.d.ts'],
}, null, 2))

// ── docs ──
const docsOut = join(kitRoot, 'docs')
mkdirSync(docsOut, { recursive: true })
for (const doc of [
  'docs/说明书/Pylon-插件系统说明书-开发者版.md',
  'docs/说明书/Pylon-插件系统说明书-用户版.md',
  'docs/说明书/Pylon-CLI-命令表.md',
  'docs/Pylon-插件设置选项贡献.md',
]) {
  cpSync(join(repoRoot, doc), join(docsOut, doc.split('/').pop()))
}

// ── README ──
writeFileSync(join(kitRoot, 'README.md'), readFileSync(join(repoRoot, 'scripts', 'plugin-devkit-README.md'), 'utf8'))

// ── verify.mjs：自检 ──
writeFileSync(join(kitRoot, 'verify.mjs'), readFileSync(join(repoRoot, 'scripts', 'plugin-devkit-verify.mjs'), 'utf8'))

// ── 质量门 ──
const sdk = await import('file:///' + join(sdkOut, 'pylon-plugin-sdk.js').replaceAll('\\', '/'))
const gate1 = ['definePlugin', 'createSettingsSurface', 'createPluginLogger', 'VISUAL_SEMANTIC_TOKENS', 'PYLON_PLUGIN_API_SUPPORTED']
  .every(key => key in sdk)
if (!gate1) { console.error('[devkit] G1 FAIL: SDK bundle 导出不完整'); process.exit(1) }
console.log('[devkit] G1 PASS: SDK bundle 导出完整')

execTsc(['-p', join(kitRoot, 'starter', 'typescript', 'tsconfig.json')])
console.log('[devkit] G2 PASS: TS starter 对套件类型树严格编译通过')

console.log(`[devkit] done → ${kitRoot}`)
readdirSync(kitRoot).forEach(name => console.log('  ' + name))

// ── helpers ──
function execTsc(args) {
  execFileSync(process.execPath, [join(repoRoot, 'node_modules', 'typescript', 'lib', 'tsc.js'), ...args], { cwd: repoRoot, stdio: 'inherit' })
}
