import { readFile, readdir, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const assetsDir = resolve(projectRoot, 'dist-solid-smoke/assets')
const assets = await readdir(assetsDir)
const javascript = assets.filter(name => name.endsWith('.js'))
const css = assets.filter(name => name.endsWith('.css'))
const errors = []

if (!javascript.some(name => name.startsWith('solid-smoke-'))) errors.push('缺少 Solid smoke entry chunk')
if (css.length === 0) errors.push('缺少 Solid smoke CSS asset')

const combined = (await Promise.all(javascript.map(name => readFile(resolve(assetsDir, name), 'utf8')))).join('\n')
if (!combined.includes('Solid Workbench browser smoke')) errors.push('产物未包含 browser smoke 文本')
if (/react-dom|react\.production|react\.development/.test(combined)) errors.push('独立 Solid smoke 产物意外包含 React runtime')

const sizes = await Promise.all(javascript.map(async name => ({ name, size: (await stat(resolve(assetsDir, name))).size })))
if (errors.length > 0) {
  console.error(`Solid smoke 产物检查失败：\n${errors.map(error => `- ${error}`).join('\n')}`)
  process.exit(1)
}

console.log(`Solid smoke 产物检查通过；JS ${sizes.map(item => `${item.name}=${item.size}B`).join(', ')}；CSS ${css.join(', ')}`)
