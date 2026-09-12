import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
// 只校验仓库内的文档指针。CI 的 checkout 仅含本仓库，兄弟目录 Docs/ 不存在，
// 跨仓库路径（渲染引擎台账位于协作工作区 G:\Project\prism-team-workdir\Docs\）
// 无法在此门禁成立，故不纳入；该指针仍作为说明留在 CONTEXT.md。
const checks = [
  ['CONTEXT architecture reference', resolve(root, 'docs/说明书/Pylon-项目架构参考.md')],
  ['CONTEXT plugin topology', resolve(root, 'docs/说明书/Pylon-插件化前后端拓扑全图.md')],
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
