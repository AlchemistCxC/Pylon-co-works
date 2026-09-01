import { readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
const dependencies = { ...packageJson.dependencies, ...packageJson.devDependencies }
const sourceFiles = []
function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const path = resolve(dir, entry)
    if (entry === 'node_modules' || entry === 'dist') continue
    if (statSync(path).isDirectory()) walk(path)
    else if (/\.(?:ts|tsx|mts|mjs)$/.test(entry)) sourceFiles.push(path)
  }
}
walk(resolve(root, 'src'))
const used = new Set()
for (const path of sourceFiles) {
  const text = readFileSync(path, 'utf8')
  for (const match of text.matchAll(/(?:from|import\s*\()\s*['"]([^'"./][^'"]*)['"]/g)) {
    const name = match[1].startsWith('@') ? match[1].split('/').slice(0, 2).join('/') : match[1].split('/')[0]
    used.add(name)
  }
}
const result = { immer: used.has('immer'), packageDeclared: Object.hasOwn(dependencies, 'immer'), sourceFiles: sourceFiles.length }
console.log(JSON.stringify(result))
if (result.packageDeclared && !result.immer) process.exitCode = 1
