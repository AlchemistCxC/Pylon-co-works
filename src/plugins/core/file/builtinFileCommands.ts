import type { CommandDefinition } from '../../../plugin-runtime/commands/commandRegistry.ts'
import { useIdentityStore } from '../../../identityStore.ts'
import { workspaceTargetFromSession } from '../../../domains/workspace/workspaceTarget.ts'
import { builtinFileProvider, builtinGitProvider } from './builtinFileWorkbench.ts'

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
function text(value: unknown, key: string, optional = false): string {
  if (optional && (value === undefined || value === null)) return ''
  if (typeof value !== 'string' || (!optional && !value.trim())) throw new Error(`${key} 必须是字符串${optional ? '' : '且不能为空'}`)
  return value.trim()
}
function target(input: Record<string, unknown>) {
  const sessionId = text(input.sessionId, 'sessionId')
  const session = useIdentityStore.getState().sessions.find(value => value.id === sessionId || value.source === sessionId)
  const resolved = workspaceTargetFromSession(session)
  if (!resolved) throw new Error(`无法解析工作区 Session：${sessionId}`)
  return resolved
}

export function createBuiltinFileCommandDefinitions(): CommandDefinition[] {
  const base = 300
  return [
    { id: 'file.entries.list', name: 'file.entries.list', description: '列出 Session 工作区目录', priority: base, inputHint: '{ "sessionId": "s1", "path": "src" }', execute: ({ args, signal }) => { const input = record(args); return builtinFileProvider.listEntries(target(input), text(input.path, 'path', true), signal) } },
    { id: 'file.text.read', name: 'file.text.read', description: '读取 Session 工作区文本文件', priority: base + 1, inputHint: '{ "sessionId": "s1", "path": "src/App.tsx" }', execute: ({ args, signal }) => { const input = record(args); return builtinFileProvider.readText(target(input), text(input.path, 'path'), signal) } },
    { id: 'file.text.write', name: 'file.text.write', description: '写入 Session 工作区文本文件', permission: 'gate', priority: base + 2, inputHint: '{ "sessionId": "s1", "path": "a.txt", "content": "..." }', execute: ({ args, signal }) => { const input = record(args); return builtinFileProvider.writeText(target(input), { relativePath: text(input.path, 'path'), content: text(input.content, 'content', true), ...(typeof input.expectedBaseline === 'string' || input.expectedBaseline === null ? { expectedBaseline: input.expectedBaseline } : {}), ...(input.force === true ? { force: true } : {}) }, signal) } },
    { id: 'file.search', name: 'file.search', description: '搜索 Session 工作区内容', priority: base + 3, inputHint: '{ "sessionId": "s1", "query": "TODO" }', execute: ({ args, signal }) => { const input = record(args); return builtinFileProvider.search(target(input), text(input.query, 'query'), signal) } },
    { id: 'git.status', name: 'git.status', description: '读取 Session 工作区 Git 状态和分支', priority: base + 4, inputHint: '{ "sessionId": "s1" }', execute: ({ args, signal }) => { const input = record(args); return builtinGitProvider.status(target(input), signal) } },
    { id: 'git.history', name: 'git.history', description: '读取 Session 工作区 Git 历史', priority: base + 5, inputHint: '{ "sessionId": "s1", "limit": 50 }', execute: ({ args, signal }) => { const input = record(args); return builtinGitProvider.history(target(input), { limit: typeof input.limit === 'number' ? input.limit : undefined }, signal) } },
    { id: 'git.diff', name: 'git.diff', description: '读取 Session 工作区 Git diff', priority: base + 6, inputHint: '{ "sessionId": "s1", "path": "src/App.tsx", "staged": false }', execute: ({ args, signal }) => { const input = record(args); return builtinGitProvider.diff(target(input), { path: text(input.path, 'path'), staged: input.staged === true }, signal) } },
  ]
}
