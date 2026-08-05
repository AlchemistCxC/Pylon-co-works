import type { AvailableCommand } from '../../infrastructure/acp/chatContracts.ts'

export interface CommandSuggestion {
  cmd: string
  args: string
  info: string
}

export const FALLBACK_COMMANDS: readonly CommandSuggestion[] = Object.freeze([
  { cmd: '/model', args: ' <name>', info: '切换模型' },
  { cmd: '/compact', args: '', info: '压缩上下文' },
  { cmd: '/new', args: '', info: '新会话' },
  { cmd: '/export', args: '', info: '导出记录' },
  { cmd: '/clear', args: '', info: '清屏' },
  { cmd: '/mode', args: ' <default|edit|auto|bypass>', info: '切换权限模式' },
])

export function resolveCommandSuggestions(commands: readonly AvailableCommand[]): CommandSuggestion[] {
  return commands.length > 0
    ? commands.map(command => ({
      cmd: '/' + command.name,
      args: command.input_hint ? ' ' + command.input_hint : '',
      info: command.description || '',
    }))
    : [...FALLBACK_COMMANDS]
}

export function filterCommandSuggestions(
  value: string,
  commands: readonly CommandSuggestion[],
): CommandSuggestion[] {
  const trimmed = value.trimStart()
  if (!trimmed.startsWith('/')) return []
  const commandName = trimmed.split(/\s+/, 1)[0]
  return commands.filter(command => command.cmd.startsWith(commandName))
}

export function parseSlashCommand(value: string): { name: string; args: string; raw: string } | null {
  const raw = value.trim()
  if (!raw.startsWith('/')) return null
  const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(raw)
  if (!match) return null
  return { name: `/${match[1]}`, args: match[2] || '', raw }
}
