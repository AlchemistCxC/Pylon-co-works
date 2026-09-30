import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative } from 'node:path'

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))

// ---------------------------------------------------------------------------
// 规则一（存量）：视图层禁止直连产品实现 plugins/product/builtinPylon*。
// ---------------------------------------------------------------------------
const forbiddenImport = /(?:from\s+|import\s*\(\s*)['"][^'"]*plugins\/product\/builtinPylon[^'"]*['"]/g

export function findForbiddenProductImplementationImports(source: string): string[] {
  return source.match(forbiddenImport) ?? []
}

// ---------------------------------------------------------------------------
// 规则二（#485 划线，方案 C）：plugins/core 定性为「经插件机制交付的首方实现」。
// core 的插件贡献面（贡献声明数据、注册入口）视图层必须走注册表消费；内部 API 面
// （契约常量、贡献产物读取端）按下方白名单符号级豁免，who/why 逐条登记，新增豁免
// = 显式评审动作。清单即文档：划线明细以本表为唯一真源，维护地图引用之。
// ---------------------------------------------------------------------------

/** 通用 import/export-from 语句抓取（各分支自带模块说明符捕获组）。 */
const importStatementRe = new RegExp(
  /import\s+(?:type\s+)?(?:(\*\s+as\s+[\w$]+)|([\w$]+)\s*,\s*)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/.source
  + /|import\s+(?:type\s+)?(?:\*\s+as\s+([\w$]+)|([\w$]+))\s*from\s*['"]([^'"]+)['"]/.source
  + /|import\s*\(\s*['"]([^'"]+)['"]\s*\)/.source
  + /|import\s*['"]([^'"]+)['"]/.source
  + /|export\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/.source
  + /|export\s+\*\s+from\s*['"]([^'"]+)['"]/.source,
  'g',
)

export interface CoreImportHit {
  /** 语句文本（违规报告用）。 */
  readonly text: string
  /** 导入的符号；`*` 表示命名空间/默认/动态/副作用/re-export-all 这类无法按符号豁免的形态。 */
  readonly symbols: readonly string[]
}

/** 分支组位：A 命名导入 ns/def/named/spec；B 单导入 ns/def/spec；C 动态 spec；D 副作用 spec；E re-export named/spec；F re-export-all spec。 */
export function findCoreImports(source: string): CoreImportHit[] {
  const hits: CoreImportHit[] = []
  for (const match of source.matchAll(importStatementRe)) {
    const [, nsA, defA, namedA, specA, nsB, defB, specB, specC, specD, namedE, specE, specF] = match
    const spec = specA ?? specB ?? specC ?? specD ?? specE ?? specF
    if (!spec || !spec.includes('plugins/core/')) continue
    const symbols: string[] = []
    const named = namedA ?? namedE
    if (nsA || nsB || defA || defB || specC || specD || specF) symbols.push('*')
    if (named) {
      for (const piece of named.split(',')) {
        const name = piece.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim()
        if (name) symbols.push(name)
      }
    }
    if (symbols.length > 0) hits.push({ text: match[0], symbols })
  }
  return hits
}

/**
 * core 内部 API 面白名单：文件（仓库相对路径，'/' 分隔）→ 符号 → 理由（who/why）。
 * 测试文件（__tests__/、*.test.*）不在扫描范围——测试本就直连被测实现。
 */
export const CORE_INTERNAL_API_ALLOWLIST: Record<string, Record<string, string>> = {
  'src/sheets/interfaceModeScenes.tsx': {
    // A-V9 宿主场景注册表：core 贡献声明（sceneSurface.surfaceId）与本表登记必须同源，防漂移；无注册表等价物。
    BUILTIN_TACTICAL_SCENE_SURFACE_ID: '[kumo/#485] 宿主场景挂点契约常量',
  },
  'src/sheets/agent-workbench/agentWorkbenchCommands.ts': {
    // builtin 会话创建贡献产物读取端：输入即注册表快照（session.creationSnapshot），按贡献 ID 匹配系产品特定语义。
    collectProfilePersona: '[kumo/#485] 贡献产物读取端（快照查询）；#486 项1 搬迁 application 后本条随迁失效可移除',
  },
  'src/sheets/agent-workbench/agentWorkbenchLifecycle.ts': {
    collectProfilePersona: '[kumo/#485] 贡献产物读取端（快照查询）；#486 项1 搬迁 application 后本条随迁失效可移除',
  },
  'src/sheets/agent-workbench/agentWorkbenchSessionCreation.ts': {
    collectProfilePersona: '[kumo/#485] 贡献产物读取端（快照查询）；#486 项1 搬迁 application 后本条随迁失效可移除',
  },
  'src/sheets/file/FileViewHost.tsx': {
    // core 读取预算与宿主截断提示的同源常量（1 MiB），改值须两端同步。
    FILE_SHEET_MAX_READ_BYTES: '[kumo/#485] core/sheet 同源预算常量',
  },
}

export function findCorePluginFaceViolations(source: string, allowSymbols: ReadonlySet<string>): string[] {
  return findCoreImports(source)
    .filter(hit => hit.symbols.includes('*') || hit.symbols.some(symbol => !allowSymbols.has(symbol)))
    .map(hit => hit.text)
}

// ---------------------------------------------------------------------------
// Guard the guard：已知违规 fixture 必须被拒，白名单 fixture 必须放行。
// ---------------------------------------------------------------------------

// 规则一：违规 fixture 必须被拒。
assert.equal(
  findForbiddenProductImplementationImports("import { apply } from '../plugins/product/builtinPylonTools'").length,
  1,
)

const lineOutside = "import { BUILTIN_INTERFACE_MODES } from '../plugins/core/interfaceMode/builtinInterfaceModes.ts'"
const lineAllowlisted = "import { BUILTIN_TACTICAL_SCENE_SURFACE_ID } from '../plugins/core/interfaceMode/builtinInterfaceModes.ts'"

// 规则二：线外符号（贡献清单）必须被拒。
assert.equal(findCorePluginFaceViolations(lineOutside, new Set(['BUILTIN_TACTICAL_SCENE_SURFACE_ID'])).length, 1)
// 规则二：白名单符号放行。
assert.deepEqual(findCorePluginFaceViolations(lineAllowlisted, new Set(['BUILTIN_TACTICAL_SCENE_SURFACE_ID'])), [])
// 规则二：多行具名列表混入白名单外符号必须被拒。
assert.equal(
  findCorePluginFaceViolations(
    "import {\n  BUILTIN_TACTICAL_SCENE_SURFACE_ID,\n  BUILTIN_INTERFACE_MODES,\n} from './plugins/core/interfaceMode/builtinInterfaceModes.ts'",
    new Set(['BUILTIN_TACTICAL_SCENE_SURFACE_ID']),
  ).length,
  1,
)
// 规则二：re-export 等效直连，同样被拒。
assert.equal(
  findCorePluginFaceViolations(
    "export { collectProfilePersona } from '../plugins/core/sessionCreation/builtinSessionCreation.ts'",
    new Set<string>(),
  ).length,
  1,
)
// 规则二：命名空间/默认/动态/副作用导入无法按符号豁免，即使白名单含 '*' 也违规。
for (const fixture of [
  "import * as coreModes from '../plugins/core/interfaceMode/builtinInterfaceModes.ts'",
  "import builtinSessionCreation from '../plugins/core/sessionCreation/builtinSessionCreation.ts'",
  "import('../plugins/core/sessionCreation/builtinSessionCreation.ts')",
  "import '../plugins/core/sessionCreation/builtinSessionCreation.ts'",
  "export * from '../plugins/core/sessionCreation/builtinSessionCreation.ts'",
]) {
  assert.equal(findCorePluginFaceViolations(fixture, new Set(['*'])).length, 1, fixture)
}
// 规则二：非 core 的 import 不受管辖。
assert.deepEqual(findCoreImports("import { something } from '../domains/interface/interfaceModeStore.ts'"), [])

function sourceFiles(path: string): string[] {
  if (!statSync(path).isDirectory()) return [path]
  return readdirSync(path).flatMap(name => sourceFiles(join(path, name)))
    .filter(file => /\.[cm]?[jt]sx?$/.test(file))
    // 测试文件不在管辖内：测试本就直连被测实现（含 plugins/core）。
    .filter(file => !file.includes('__tests__') && !/\.test\.[cm]?[jt]sx?$/.test(file))
}

function allowSymbolsFor(file: string): Set<string> {
  return new Set(Object.keys(CORE_INTERNAL_API_ALLOWLIST[file] ?? {}))
}

const violations = [
  join(repoRoot, 'src', 'App.tsx'),
  ...sourceFiles(join(repoRoot, 'src', 'components')),
  ...sourceFiles(join(repoRoot, 'src', 'sheets')),
].flatMap(file => {
  const relFile = relative(repoRoot, file).replaceAll('\\', '/')
  const source = readFileSync(file, 'utf8')
  const productHits = findForbiddenProductImplementationImports(source)
    .map(match => `[product] ${relFile}: ${match}`)
  const coreHits = findCorePluginFaceViolations(source, allowSymbolsFor(relFile))
    .map(match => `[core 插件面] ${relFile}: ${match}（内部 API 面白名单见本脚本 CORE_INTERNAL_API_ALLOWLIST；合理直连请登记符号并附理由）`)
  return [...productHits, ...coreHits]
})

assert.deepEqual(
  violations,
  [],
  `视图层（App/components/sheets）必须经注册表/贡献端口消费产品与 core：\n${violations.join('\n')}`,
)

console.log(`product contribution boundary passed（App/components/sheets；core 划线白名单 ${Object.values(CORE_INTERNAL_API_ALLOWLIST).reduce((n, r) => n + Object.keys(r).length, 0)} 条符号豁免）`)
