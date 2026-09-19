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
import { getPromptContributionRegistry } from '../plugin-runtime/runtimeServices.ts'
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

/**
 * #201：sessionPrompt 组装唯一入口（插件化注入系统）。
 *
 * 分层与顺序（不可配置——宿主身份语义先于扩展段）：
 *  1. identity 段（order 0）：snapshot 前导或 persona（二者互斥，见
 *     `sessionRuntime.buildSendMessagePayload` 的既有语义）；
 *  2. session 段（order 50）：用户在会话上写的 sessionPrompt；
 *  3. 命令清单段（order 90）：`buildAgentCommandPrompt`（v2 Command Registry）；
 *  4. 扩展段（order ≥ 100）：`PromptContributionRegistry` 的插件贡献（skill
 *     清单、MCP 描述等），按 order 排序、按各段 maxBytes 截断（预算内截断保头，
 *     越预算整段丢弃并留一行说明——不静默）。
 *
 * Rust 首轮门禁与 replay 剥离（`

---

` 分隔）只关心「前缀整体 vs 用户
 * 原文」，不感知段结构——扩展段的增减不影响剥离语义。
 */
export interface AssembleSessionPromptInput {
  /** identity 段二选一：creation snapshot 前导优先，缺省回退 persona。 */
  readonly snapshotPrelude?: string
  readonly persona?: string
  /** 用户会话 prompt（Session.sessionPrompt）。 */
  readonly sessionPrompt?: string
  readonly agentId?: string
  readonly profileId?: string
  /** 会话启用插件 id；缺省 = 全部（与命令清单同语义）。 */
  readonly enabledPluginIds?: readonly string[]
}

export const SESSION_PROMPT_IDENTITY_ORDER = 0
export const SESSION_PROMPT_SESSION_ORDER = 50
export const SESSION_PROMPT_COMMANDS_ORDER = 90

export function assembleSessionPrompt(input: AssembleSessionPromptInput = {}): string {
  const identity = input.snapshotPrelude?.trim() || input.persona?.trim() || ''
  const sessionPrompt = input.sessionPrompt?.trim() ?? ''
  const commandBlock = buildAgentCommandPrompt({
    agentId: input.agentId,
    profileId: input.profileId,
    enabledPluginIds: input.enabledPluginIds,
  })
  const extensions = getPromptContributionRegistry()
    .resolveTarget('session-prompt', input.enabledPluginIds)
  const segments: string[] = []
  if (identity) segments.push(identity)
  if (sessionPrompt) segments.push(sessionPrompt)
  if (commandBlock) segments.push(commandBlock)
  for (const contribution of extensions) {
    const budget = contribution.maxBytes ?? 2048
    if (contribution.text.length > budget) {
      segments.push(`${contribution.text.slice(0, budget)}\n（贡献段 ${contribution.id} 超预算截断）`)
      continue
    }
    segments.push(contribution.text)
  }
  return segments.filter(Boolean).join('\n\n')
}
