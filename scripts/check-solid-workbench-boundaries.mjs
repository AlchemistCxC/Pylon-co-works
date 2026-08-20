import { readFile, readdir, stat } from 'node:fs/promises'
import { extname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const solidRoot = resolve(projectRoot, 'src/renderers/solid-workbench')
const forbiddenPackages = [
  'react',
  'react-dom',
  'motion/react',
  'lucide-react',
  'react-markdown',
  '@testing-library/react',
]
const forbiddenPrefixes = ['@tauri-apps/']
const sourceExtensions = new Set(['.ts', '.tsx', '.mts', '.js', '.jsx', '.mjs'])
const violations = []

for (const file of await walk(solidRoot)) {
  if (!sourceExtensions.has(extname(file))) continue
  const source = await readFile(file, 'utf8')
  const displayPath = relative(projectRoot, file).replaceAll('\\', '/')
  const imports = collectModuleSpecifiers(source)

  for (const specifier of imports) {
    const forbiddenPackage = forbiddenPackages.find(name => specifier === name || specifier.startsWith(`${name}/`))
    const forbiddenPrefix = forbiddenPrefixes.find(prefix => specifier.startsWith(prefix))
    if (forbiddenPackage || forbiddenPrefix) {
      // React host 与 React host 测试是受控边界，不属于 Solid renderer dependency graph。
      const isReactHostBoundary = displayPath.endsWith('/SolidWorkbenchSmokeHost.tsx')
        || displayPath.endsWith('/SolidWorkbenchSmokeHost.test.tsx')
      if (!isReactHostBoundary) violations.push(`${displayPath}: 禁止 import ${specifier}`)
    }
  }

  if (displayPath.endsWith('.solid.tsx') || displayPath.endsWith('.solid.test.tsx')) continue
  if (looksLikeSolidJsx(source)) {
    violations.push(`${displayPath}: Solid JSX 必须使用 .solid.tsx 或 .solid.test.tsx 扩展名`)
  }
}

if (violations.length > 0) {
  console.error(`Solid Workbench 边界检查失败：\n${violations.map(item => `- ${item}`).join('\n')}`)
  process.exit(1)
}

console.log(`Solid Workbench 边界检查通过；扫描 ${await countSourceFiles(solidRoot)} 个源码文件`)

function collectModuleSpecifiers(source) {
  const values = []
  const patterns = [
    /\b(?:import|export)\s+(?:type\s+)?(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ]
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) values.push(match[1])
  }
  return values
}

function looksLikeSolidJsx(source) {
  return /\bclass=(["'{])/.test(source)
    || /\b(?:For|Show|Switch|Match|Index|Dynamic)\s*[<(]/.test(source)
    || /from\s+['"]solid-js(?:\/web)?['"]/.test(source)
}

async function walk(directory) {
  const output = []
  for (const name of await readdir(directory)) {
    const path = resolve(directory, name)
    const info = await stat(path)
    if (info.isDirectory()) output.push(...await walk(path))
    else output.push(path)
  }
  return output
}

async function countSourceFiles(directory) {
  return (await walk(directory)).filter(file => sourceExtensions.has(extname(file))).length
}
