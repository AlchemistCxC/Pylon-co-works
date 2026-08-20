import { globSync, readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { FIRST_PARTY_STYLE_OWNERSHIP } from '../src/plugins/product/firstPartyStyleOwnership.ts'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const sourceFiles = globSync('src/**/*.{ts,tsx}', {
  cwd: root,
  exclude: ['src/**/*.d.ts'],
}).sort()

function normalize(path) {
  return path.replaceAll('\\', '/')
}

function resolveCssPath(importerPath, specifier) {
  const [path, query = ''] = specifier.split('?', 2)
  if (!path.endsWith('.css') || path.startsWith('@')) return undefined
  return {
    cssPath: normalize(relative(root, resolve(root, importerPath, '..', path))),
    mode: query === 'inline' ? 'inline' : 'static',
  }
}

const actualImporters = new Map()
function addImporter(cssPath, importerPath, mode) {
  const importers = actualImporters.get(cssPath) ?? []
  importers.push({ path: normalize(importerPath), mode })
  actualImporters.set(cssPath, importers)
}

for (const importerPath of sourceFiles) {
  const sourceText = readFileSync(resolve(root, importerPath), 'utf8')
  const sourceFile = ts.createSourceFile(importerPath, sourceText, ts.ScriptTarget.Latest, true)
  function visit(node) {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const styleImport = resolveCssPath(importerPath, node.moduleSpecifier.text)
      if (styleImport) addImporter(styleImport.cssPath, importerPath, styleImport.mode)
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
      && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])) {
      const styleImport = resolveCssPath(importerPath, node.arguments[0].text)
      if (styleImport) addImporter(styleImport.cssPath, importerPath, styleImport.mode)
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && node.expression.expression.kind === ts.SyntaxKind.ImportKeyword
      && node.expression.name.text === 'meta') return
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)

  const globPattern = /import\.meta\.glob(?:<[^>]+>)?\(\s*\[([\s\S]*?)\]\s*,\s*\{[\s\S]*?query:\s*['"]\?inline['"][\s\S]*?\}\s*\)/g
  for (const match of sourceText.matchAll(globPattern)) {
    for (const item of match[1].matchAll(/['"]([^'"]+\.css)['"]/g)) {
      const styleImport = resolveCssPath(importerPath, `${item[1]}?inline`)
      if (styleImport) addImporter(styleImport.cssPath, importerPath, 'inline')
    }
  }
}

const inventory = new Map(FIRST_PARTY_STYLE_OWNERSHIP.map(entry => [entry.path, entry]))
const failures = []
for (const [cssPath, importerEntries] of actualImporters) {
  const declared = inventory.get(cssPath)
  if (!declared) {
    failures.push(`未登记 CSS：${cssPath}（importers: ${importerEntries.map(item => item.path).join(', ')}）`)
    continue
  }
  const actual = [...new Set(importerEntries.map(item => item.path))].sort()
  const expected = [...declared.importers].sort()
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    failures.push(`CSS importer 漂移：${cssPath}\n  expected: ${expected.join(', ')}\n  actual:   ${actual.join(', ')}`)
  }
  const expectedMode = declared.lifecycle === 'plugin-scope' ? 'inline' : 'static'
  const actualModes = [...new Set(importerEntries.map(item => item.mode))]
  if (actualModes.length !== 1 || actualModes[0] !== expectedMode) {
    failures.push(`CSS lifecycle import 错误：${cssPath}\n  lifecycle: ${declared.lifecycle}\n  expected import: ${expectedMode}\n  actual: ${actualModes.join(', ')}`)
  }
}
for (const [cssPath, declared] of inventory) {
  if (!actualImporters.has(cssPath)) failures.push(`登记的 CSS 无源码 import：${cssPath}（owner: ${declared.owner}）`)
}

if (failures.length > 0) throw new Error(`第一方 CSS ownership 守卫失败（${failures.length}）：\n${failures.join('\n')}`)

const counts = new Map()
for (const item of FIRST_PARTY_STYLE_OWNERSHIP) counts.set(item.owner, (counts.get(item.owner) ?? 0) + 1)
console.log(`第一方 CSS ownership 守卫通过：${FIRST_PARTY_STYLE_OWNERSHIP.length} files`)
for (const [owner, count] of [...counts].sort(([a], [b]) => a.localeCompare(b))) console.log(`  ${owner}: ${count}`)
