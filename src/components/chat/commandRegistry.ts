import { useMemo, useSyncExternalStore } from 'react'
import type { AvailableCommand } from '../../infrastructure/acp/chatContracts.ts'
import {
  resolveCommandSetSuggestions,
  subscribePluginCommands,
} from '../../host/commandSetResolver.ts'
import { getCommandRegistry } from '../../plugin-runtime/runtimeServices.ts'

export interface CommandSuggestion {
  cmd: string
  args: string
  info: string
}

export function resolveFallbackCommands(): readonly CommandSuggestion[] {
  return resolveCommandSetSuggestions([])
}

/** @deprecated 使用 resolveFallbackCommands 或 usePluginCommandSuggestions，避免模块导入期静态快照。 */
export const FALLBACK_COMMANDS: readonly CommandSuggestion[] = Object.freeze(resolveFallbackCommands())

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
