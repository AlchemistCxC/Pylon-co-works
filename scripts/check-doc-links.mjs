import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const externalDocs = resolve(root, '..', 'Docs')
const checks = [
  ['CONTEXT architecture reference', resolve(root, 'docs/说明书/Pylon-项目架构参考.md')],
  ['CONTEXT plugin topology', resolve(root, 'docs/说明书/Pylon-插件化前后端拓扑全图.md')],
  ['CONTEXT renderer ledger', resolve(externalDocs, 'Archive/渲染引擎施工/00-唯一入口台账.md')],
]
const missing = checks.filter(([, path]) => !existsSync(path))
if (missing.length) {
  console.error(`文档链接检查失败：\n${missing.map(([label, path]) => `- ${label}: ${path}`).join('\n')}`)
  process.exit(1)
}
const context = readFileSync(resolve(root, 'CONTEXT.md'), 'utf8')
for (const [label, path] of checks) {
  const name = path.split(/[\\/]/).pop()
  if (!context.includes(name)) {
    console.error(`文档链接检查失败：CONTEXT 缺少 ${label} (${name})`)
    process.exit(1)
  }
}
console.log(`文档链接检查通过（${checks.length} 项）`)
