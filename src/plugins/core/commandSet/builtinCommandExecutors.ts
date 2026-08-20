import { invoke } from '@tauri-apps/api/core'
import type { CommandDefinition } from '../../../plugin-runtime/commands/commandRegistry.ts'
import { CORE_BUILTIN_COMMANDS } from './builtinCommands.ts'
import { useIdentityStore } from '../../../identityStore.ts'
import { setSessionModel } from '../../../components/chat/sessionModel.ts'
import { setSessionMode } from '../../../components/chat/sessionMode.ts'
import { createSessionClient } from '../../../infrastructure/acp/sessionClient.ts'
import { createCliSessionControlPort } from '../../../cli/pylonCliDomainPorts.ts'
import { useWorkspaceStore } from '../../../workspaceStore.ts'

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function text(value: unknown, key: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${key} 必须是非空字符串`)
  return value.trim()
}

function positional(args: Record<string, unknown>, index: number): unknown {
  return Array.isArray(args.positionals) ? args.positionals[index] : undefined
}

function sessionFrom(args: Record<string, unknown>) {
  const workspace = useWorkspaceStore.getState()
  const activeSheet = workspace.workspaceSheets.sheets.find(sheet => sheet.id === workspace.workspaceSheets.activeSheetId)
  const activeSessionId = activeSheet?.agentId ? workspace.sheetAgentStates[activeSheet.agentId]?.activeSessionId : undefined
  const sessionId = typeof args.sessionId === 'string' && args.sessionId.trim() ? args.sessionId.trim() : activeSessionId
  if (!sessionId) throw new Error('sessionId 缺失，且当前活动 Sheet 没有选中 Session')
  const session = useIdentityStore.getState().sessions.find(value => value.id === sessionId || value.source === sessionId)
  if (!session) throw new Error(`Session 不存在：${sessionId}`)
  return session
}

function signalOrNew(signal?: AbortSignal): AbortSignal {
  return signal ?? new AbortController().signal
}

/** Executable counterparts of the six built-in slash commands. */
export function createBuiltinCommandDefinitions(): CommandDefinition[] {
  const sessions = createCliSessionControlPort()
  const transport = { invoke: (command: string, args?: unknown) => invoke(command, args as Record<string, unknown> | undefined) }
  const sessionClient = createSessionClient(transport)
  const executeByName: Record<string, NonNullable<CommandDefinition['execute']>> = {
    model: async ({ args }) => {
      const input = record(args)
      const session = sessionFrom(input)
      const model = text(input.name ?? input.model ?? positional(input, 0), 'name')
      await setSessionModel({ agentId: session.agentId, source: session.source }, model)
      return { sessionId: session.id, model }
    },
    mode: async ({ args }) => {
      const input = record(args)
      const session = sessionFrom(input)
      const mode = text(input.name ?? input.mode ?? positional(input, 0), 'mode')
      await setSessionMode({ agentId: session.agentId, source: session.source }, mode)
      return { sessionId: session.id, mode }
    },
    compact: ({ args, signal }) => {
      const input = record(args)
      return sessions.send(sessionFrom(input).id, '/compact', { signal: signalOrNew(signal) })
    },
    new: ({ args, signal }) => {
      const input = record(args)
      return sessions.create({
        ...(typeof input.agentId === 'string' ? { agentId: input.agentId } : {}),
        ...(typeof input.cwd === 'string' ? { cwd: input.cwd } : {}),
        ...(typeof input.workspaceId === 'string' ? { workspaceId: input.workspaceId } : {}),
        ...(typeof input.title === 'string' ? { title: input.title } : {}),
      }, { signal: signalOrNew(signal) })
    },
    export: async ({ args }) => {
      const input = record(args)
      const session = sessionFrom(input)
      if (!session.periId) throw new Error(`Session 尚无远端持久化 id：${session.id}`)
      const outputPath = text(input.outputPath ?? input.out ?? positional(input, 0), 'outputPath')
      const format = typeof input.format === 'string' && input.format.trim() ? input.format.trim() : 'markdown'
      await sessionClient.exportSession({ agentId: session.agentId, periId: session.periId, format, outputPath })
      return { sessionId: session.id, outputPath, format }
    },
    clear: ({ args }) => {
      const input = record(args)
      if (typeof window === 'undefined') throw new Error('clear 需要活动 GUI 内核')
      window.dispatchEvent(new CustomEvent('peri:clear', { detail: { sessionId: input.sessionId } }))
      return { cleared: true, sessionId: typeof input.sessionId === 'string' ? input.sessionId : null }
    },
  }
  return CORE_BUILTIN_COMMANDS.map(command => ({ ...command, id: command.name, execute: executeByName[command.name] }))
}
