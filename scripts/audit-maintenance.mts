/** Read-only maintenance inventory. Module ownership is architectural, not a list of people. */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ESLint } from 'eslint'

export const moduleDefinitions = [
  { id: 'contracts', roots: ['src/contracts/', 'src/sdk/'], responsibility: '公开语义与插件 SDK；兼容性在调用者边界验证' },
  { id: 'domain', roots: ['src/domains/'], responsibility: '领域模型、投影与策略；不新增 UI / IPC / 全局 store 依赖' },
  { id: 'application', roots: ['src/app/', 'src/application/', 'src/kernel/'], responsibility: '应用启动、恢复与事务；不等同于全部概念 Kernel' },
  { id: 'infrastructure', roots: ['src/infrastructure/'], responsibility: 'IPC、持久化、事件传输与系统适配' },
  { id: 'plugin-host', roots: ['src/plugin-runtime/'], responsibility: '扩展注册、激活、隔离、授权和资源 Scope' },
  { id: 'product-plugins', roots: ['src/plugins/'], responsibility: '第一方产品包与贡献实现；plugins/core 仍属产品层' },
  { id: 'workbench-host', roots: ['src/host/', 'src/sheets/agent-workbench/'], responsibility: 'Renderer Suite 宿主、会话绑定与命令编排；文档状态所有者' },
  { id: 'renderers', roots: ['src/renderers/'], responsibility: '文档到 UI 的呈现与交互适配；消费 Host Port' },
  { id: 'workspace-ui', roots: ['src/sheets/', 'src/workspace-sheets/', 'src/components/'], responsibility: 'Sheet、设置、工作区与既有组件；chat 目录含待迁移的编排' },
  { id: 'cli', roots: ['src/cli/'], responsibility: 'CLI 语法、执行与领域命令适配' },
  { id: 'diagnostics', roots: ['src/obs04/', 'src/obs05/', 'src/obs06/', 'src/obs07/'], responsibility: '观测、诊断与导出；历史编号目录需按消费者逐步整理' },
  { id: 'layout-policy', roots: ['src/css01/', 'src/css04/', 'src/cwd02/'], responsibility: '历史布局、样式和工作目录策略；保留调用语义后再迁移' },
  { id: 'shared-utilities', roots: ['src/utils/'], responsibility: '已有窄工具函数；新代码优先归属具体能力模块' },
  { id: 'demo', roots: ['src/demo/'], responsibility: '浏览器演示数据；不得把演示验证当作原生链路证据' },
  { id: 'frontend-root', roots: ['src/*'], responsibility: '旧根级 store、schema、入口和公共策略；按真实调用者逐步下沉' },
  { id: 'rust-acp', roots: ['src-tauri/src/acp/', 'src-tauri/src/dispatcher/', 'src-tauri/src/lifecycle/'], responsibility: 'ACP 协商、传输、实例生命周期和通知分发' },
  { id: 'rust-session', roots: ['src-tauri/src/session/'], responsibility: '会话事务、replay 与持久化；保持 owner/generation 和提交顺序' },
  { id: 'rust-host', roots: ['src-tauri/src/'], responsibility: 'Tauri 注册、native adapters、文件/终端/Gateway/插件服务' },
  { id: 'rust-core', roots: ['src-tauri/pylon-core/src/'], responsibility: '可复用 Agent catalog、检测与 preflight 能力' },
  { id: 'rust-foundations', roots: ['src-tauri/pylon-foundations/src/'], responsibility: '跨宿主基础类型与策略' },
  { id: 'pet-core', roots: ['src-tauri/pet-core/src/'], responsibility: '独立宠物领域能力' },
  { id: 'rust-build', roots: ['src-tauri/*'], responsibility: '原生构建入口脚本；不属于运行时模块' },
  { id: 'tooling', roots: ['scripts/'], responsibility: '开发、校验与发布脚本；不作为产品运行时 import 来源' },
] as const

const moduleRoots = moduleDefinitions.flatMap(module => module.roots.map(root => ({ id: module.id, root })))
  .sort((left, right) => right.root.length - left.root.length)

export function isMaintainedSource(path: string): boolean {
  return /\.(?:[cm]?[jt]sx?|rs|py|ps1|sh)$/.test(path)
    && !/(?:^|\/)(?:__tests__|__fixtures__|test|tests|vendor|target|node_modules)\//.test(path)
    && !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path)
    && !/\.d\.[cm]?ts$/.test(path)
    && !path.startsWith('src-tauri/resources/')
    && /^(?:src\/|src-tauri\/|scripts\/)/.test(path)
}

export function moduleFor(path: string): string | undefined {
  return moduleRoots.find(({ root }) => root.endsWith('*')
    ? path.startsWith(root.slice(0, -1)) && !path.slice(root.length - 1).includes('/')
    : path.startsWith(root))?.id
}

async function audit() {
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
  const paths = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8' })
    .split('\0').filter(isMaintainedSource)
  const files = [...new Set(paths)].filter(path => existsSync(resolve(root, path)))
    .map(path => ({ path, module: moduleFor(path), lines: readFileSync(resolve(root, path), 'utf8').split('\n').length }))
  const unmapped = files.filter(file => !file.module)
  const modules = moduleDefinitions.map(module => ({ ...module, files: files.filter(file => file.module === module.id).length }))
  const report: Record<string, unknown> = { modules, sourceFiles: files.length, unmapped, largestFiles: files.toSorted((a, b) => b.lines - a.lines).slice(0, 25) }
  if (process.argv.includes('--naming')) {
    const eslint = new ESLint({ cwd: root })
    const results = await eslint.lintFiles(files.filter(file => /^src\/.+\.tsx?$/.test(file.path)).map(file => file.path))
    report.namingFindings = results.flatMap(result => result.messages
      .filter(message => message.ruleId === '@typescript-eslint/naming-convention')
      .map(message => ({ path: relative(root, result.filePath).replaceAll('\\', '/'), line: message.line, message: message.message })))
  }
  console.log(JSON.stringify(report, null, 2))
  if (unmapped.length > 0) process.exitCode = 1
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await audit()
