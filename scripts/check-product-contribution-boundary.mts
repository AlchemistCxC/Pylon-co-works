import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative } from 'node:path'

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const forbiddenImport = /(?:from\s+|import\s*\(\s*)['"][^'"]*plugins\/product\/builtinPylon[^'"]*['"]/g

export function findForbiddenProductImplementationImports(source: string): string[] {
  return source.match(forbiddenImport) ?? []
}

function sourceFiles(path: string): string[] {
  if (!statSync(path).isDirectory()) return [path]
  return readdirSync(path).flatMap(name => sourceFiles(join(path, name)))
    .filter(file => /\.[cm]?[jt]sx?$/.test(file))
}

// Guard the guard: a known violating fixture must be rejected.
assert.equal(
  findForbiddenProductImplementationImports("import { apply } from '../plugins/product/builtinPylonTools'").length,
  1,
)

const violations = [
  join(repoRoot, 'src', 'App.tsx'),
  ...sourceFiles(join(repoRoot, 'src', 'components')),
].flatMap(file => findForbiddenProductImplementationImports(readFileSync(file, 'utf8'))
  .map(match => `${relative(repoRoot, file)}: ${match}`))

assert.deepEqual(
  violations,
  [],
  `Product Shell/components must consume app ports, not builtin product implementations:\n${violations.join('\n')}`,
)

console.log('product contribution boundary passed')
