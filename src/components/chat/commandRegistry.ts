import { useMemo, useSyncExternalStore } from 'react'
import type { AvailableCommand } from '../../infrastructure/acp/chatContracts.ts'
import type { CommandTier } from '../../contracts/agentCommandSet.ts'
import {
  resolveCommandSetDescriptors,
  resolveCommandSetSuggestions,
  subscribePluginCommands,
} from '../../host/commandSetResolver.ts'
import { getCommandRegistry } from '../../plugin-runtime/runtimeServices.ts'

export interface CommandSuggestion {
  cmd: string
  args: string
  info: string
  /** 检索关键词（中英双语）；命令名是英文唯一键，中文界面下靠它可达。 */
  keywords?: readonly string[]
  /** 可见性档；`internal` 折叠在「全部」里（#329）。 */
  tier?: CommandTier
}

export function resolveFallbackCommands(): readonly CommandSuggestion[] {
  return resolveCommandSetSuggestions([])
}

export function usePluginCommandSuggestions(): readonly CommandSuggestion[] {
  const snapshot = useSyncExternalStore(
    subscribePluginCommands,
    () => getCommandRegistry().getSnapshot(),
    () => getCommandRegistry().getSnapshot(),
  )
  return useMemo(() => resolveFallbackCommands(), [snapshot])
}

export function resolveCommandSuggestions(commands: readonly AvailableCommand[]): CommandSuggestion[] {
  return resolveCommandSetSuggestions(commands)
}

/** 宿主注册表里各命令的检索词与可见性档，按命令名（小写）索引。 */
function pluginCommandMetadata(): ReadonlyMap<string, { keywords?: readonly string[]; tier: CommandTier }> {
  const table = new Map<string, { keywords?: readonly string[]; tier: CommandTier }>()
  for (const command of resolveCommandSetDescriptors()) {
    table.set(command.name.toLowerCase(), {
      ...(command.keywords ? { keywords: command.keywords } : {}),
      tier: command.tier ?? 'internal',
    })
  }
  return table
}

/**
 * 把宿主注册表里的元数据（检索词 + 可见性档）按命令名并回一组建议项。
 *
 * 会话上报的命令（`session.commands`）只有英文名与描述，没有这两个字段；输入栏在
 * 「agent 上报了命令」这条分支上只用上报项，于是中文界面下 `/新` 又搜不到（#327），
 * 分层也落不了地（#329）。`fallbackTier` 是注册表里查不到该命令时的档位。
 */
export function decorateSuggestions(
  suggestions: readonly CommandSuggestion[],
  fallbackTier: CommandTier,
): CommandSuggestion[] {
  const metadata = pluginCommandMetadata()
  return suggestions.map(suggestion => {
    const matched = metadata.get(suggestion.cmd.slice(1).toLowerCase())
    return { ...suggestion, tier: matched?.tier ?? fallbackTier, ...(matched?.keywords ? { keywords: matched.keywords } : {}) }
  })
}

/**
 * 默认层筛选：只保留 user 级命令（`internal` 是折叠层，由调用方的「全部」控件负责展开）。
 *
 * 判定归这里而不是各调用点自己写 `filter(s => s.tier !== ...)`——下一个消费者（启动器、
 * CLI 面板…）不该有机会静默拿到 77 条内部命令（#329 审查）。
 */
export function selectUserTier(suggestions: readonly CommandSuggestion[]): CommandSuggestion[] {
  return suggestions.filter(suggestion => suggestion.tier !== 'internal')
}

/**
 * 过滤 `/` 建议列表。
 *
 * 命令名按前缀匹配（命令名是英文唯一键，前缀是最省输入的用法）；`keywords` 按子串匹配
 * ——中文没有词边界，「会话」应当能命中关键词「新会话」。两者都大小写不敏感。
 */
export function filterCommandSuggestions(
  value: string,
  commands: readonly CommandSuggestion[],
): CommandSuggestion[] {
  const trimmed = value.trimStart()
  if (!trimmed.startsWith('/')) return []
  const typed = trimmed.split(/\s+/, 1)[0]!.slice(1).toLowerCase()
  if (!typed) return [...commands]
  return commands.filter(command => {
    if (command.cmd.slice(1).toLowerCase().startsWith(typed)) return true
    return (command.keywords ?? []).some(keyword => keyword.toLowerCase().includes(typed))
  })
}

export function parseSlashCommand(value: string): { name: string; args: string; raw: string } | null {
  const raw = value.trim()
  if (!raw.startsWith('/')) return null
  const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(raw)
  if (!match) return null
  return { name: `/${match[1]}`, args: match[2] || '', raw }
}
