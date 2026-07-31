export interface ParsedCommand {
  name: string
  args: string
  raw: string
}

/** 只解析以 slash 开头的单行命令；未知命令仍由调用方按普通文本处理。 */
export function parseSlashCommand(value: string): ParsedCommand | null {
  const raw = value.trim()
  if (!raw.startsWith('/')) return null
  const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(raw)
  if (!match) return null
  return { name: `/${match[1]}`, args: match[2] || '', raw }
}

export interface CommandSuggestion {
  cmd: string
  args: string
  info: string
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
