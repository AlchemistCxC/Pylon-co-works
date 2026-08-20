/**
 * commandSetResolver —— v2 Command Registry 的宿主消费面。
 *
 * - 内置/插件命令统一由响应式 CommandRegistry 提供；
 * - 人机侧 suggestions 与 agent 侧 prompt 片段同源；
 * - agent 上报的 available_commands 只覆盖人机侧展示，不污染 prompt 注入；
 * - prompt 注入按 COMMAND_PROMPT_BUDGET 截断。
 */
import {
  CORE_COMMAND_SET_PLUGIN_ID,
  COMMAND_PROMPT_BUDGET,
  type CommandSetDescriptor,
} from '../contracts/agentCommandSet.ts'
import { getCommandRegistry } from '../plugin-runtime/runtimeServices.ts'
import { BUILTIN_PYLON_TOOLS_ID } from '../plugins/product/productPluginIds.ts'

export interface AgentReportedCommand {
  name: string
  input_hint?: string
  description?: string
}

export interface CommandSetPromptContext {
  agentId?: string
  profileId?: string
  /** 会话启用插件 id；缺省 = 全部已激活 command 插件。 */
  enabledPluginIds?: readonly string[]
}

export interface CommandSetSuggestion {
  cmd: string
  args: string
  info: string
}

function dedupeAndSort(commands: readonly CommandSetDescriptor[]): CommandSetDescriptor[] {
  const byName = new Map<string, CommandSetDescriptor>()
  for (const command of commands) {
    const key = command.name.toLowerCase()
    if (!byName.has(key)) byName.set(key, command)
  }
  return [...byName.values()].sort((a, b) => {
    const priorityDelta = (a.priority ?? 1000) - (b.priority ?? 1000)
    return priorityDelta !== 0 ? priorityDelta : (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
  })
}

export function subscribePluginCommands(listener: () => void): () => void {
  return getCommandRegistry().subscribe(listener)
}

/** 全部插件命令（Registry 顺序 → command priority/name）。 */
export function resolvePluginCommands(enabledPluginIds?: readonly string[]): CommandSetDescriptor[] {
  const normalizedOwnerIds = enabledPluginIds?.map(pluginId => (
    pluginId === CORE_COMMAND_SET_PLUGIN_ID ? BUILTIN_PYLON_TOOLS_ID : pluginId
  ))
  const descriptors = getCommandRegistry().list({ ownerPluginIds: normalizedOwnerIds })
  return dedupeAndSort(descriptors.map(command => ({
    name: command.name,
    ...(command.aliases ? { aliases: command.aliases } : {}),
    description: command.description,
    ...(command.inputHint ? { inputHint: command.inputHint } : {}),
    ...(command.agentPromptSnippet ? { agentPromptSnippet: command.agentPromptSnippet } : {}),
    ...(command.permission ? { permission: command.permission } : {}),
    priority: command.priority,
  })))
}

export function resolveCommandSetDescriptors(
  agentCommands?: readonly AgentReportedCommand[],
  enabledPluginIds?: readonly string[],
): CommandSetDescriptor[] {
  const merged = new Map<string, CommandSetDescriptor>()
  for (const command of resolvePluginCommands(enabledPluginIds)) {
    merged.set(command.name.toLowerCase(), command)
  }
  for (const reported of agentCommands ?? []) {
    const key = reported.name.toLowerCase()
    const existing = merged.get(key)
    if (existing) {
      merged.set(key, {
        ...existing,
        description: reported.description || existing.description,
        inputHint: reported.input_hint || existing.inputHint,
      })
    } else {
      merged.set(key, {
        name: reported.name,
        description: reported.description || '',
        inputHint: reported.input_hint,
        priority: 0,
      })
    }
  }
  return dedupeAndSort([...merged.values()])
}

export function resolveCommandSetSuggestions(
  agentCommands?: readonly AgentReportedCommand[],
  enabledPluginIds?: readonly string[],
): CommandSetSuggestion[] {
  return resolveCommandSetDescriptors(agentCommands, enabledPluginIds).map(command => ({
    cmd: `/${command.name}`,
    args: command.inputHint ? ` ${command.inputHint}` : '',
    info: command.description || '',
  }))
}

function descriptorLine(command: CommandSetDescriptor): string {
  if (command.agentPromptSnippet) return command.agentPromptSnippet
  const hint = command.inputHint ? ` ${command.inputHint}` : ''
  return `/${command.name}${hint}：${command.description}`
}

export function buildAgentCommandPrompt(context: CommandSetPromptContext = {}): string {
  const commands = resolvePluginCommands(context.enabledPluginIds)
  if (commands.length === 0) return ''
  const lines: string[] = []
  let used = 0
  let truncated = false
  for (const command of commands) {
    const line = descriptorLine(command)
    const next = used + line.length + (lines.length > 0 ? 1 : 0)
    if (next > COMMAND_PROMPT_BUDGET) {
      truncated = true
      break
    }
    lines.push(line)
    used = next
  }
  const block = ['可用 CLI 命令：', ...lines.map(line => `- ${line}`)]
  if (truncated) {
    block.push(`（命令清单按优先级截断，共 ${commands.length} 条，已展示 ${lines.length} 条）`)
  }
  return block.join('\n')
}

export function injectAgentCommandPrompt(session: {
  sessionPrompt?: string
  agentId?: string
  profileId?: string
  commandSetPlugins?: readonly string[]
}): string {
  const base = session.sessionPrompt?.trim() ?? ''
  const injected = buildAgentCommandPrompt({
    agentId: session.agentId,
    profileId: session.profileId,
    enabledPluginIds: session.commandSetPlugins,
  })
  return [base, injected].filter(Boolean).join('\n\n')
}
