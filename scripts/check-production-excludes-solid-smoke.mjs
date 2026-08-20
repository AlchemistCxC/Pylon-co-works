import { readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const assetsDir = resolve(projectRoot, 'dist/assets')
const files = await readdir(assetsDir)
const javascript = files.filter(name => name.endsWith('.js'))
const combined = (await Promise.all(javascript.map(name => readFile(resolve(assetsDir, name), 'utf8')))).join('\n')
const errors = []

if (combined.includes('Solid Workbench browser smoke')) errors.push('生产产物包含 browser smoke harness')
if (combined.includes('Solid Workbench smoke')) errors.push('生产产物包含 Solid smoke renderer')
if (files.some(name => /^solid-(?:smoke|chunk)-/.test(name))) errors.push('生产 assets 出现独立 Solid smoke chunk')

if (errors.length > 0) {
  console.error(`生产产物隔离检查失败：\n${errors.map(error => `- ${error}`).join('\n')}`)
  process.exit(1)
}

console.log(`生产产物隔离检查通过；扫描 ${javascript.length} 个 JS assets，未包含 Solid smoke`)
