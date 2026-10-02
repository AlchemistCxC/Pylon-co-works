import type { PluginIdentity } from '../plugin-runtime/pluginIdentity.ts'
import type { HotSwapMode, PluginUpdateResult } from '../plugin-runtime/shadowUpdate.ts'
import type { HookTraceEntry } from '../plugin-runtime/hooks/hookTypes.ts'
import type { PluginProcessDescriptor, PluginProcessLogEntry } from '../infrastructure/plugins/pluginProcessClient.ts'
import type { SheetRecord } from '../workspace-sheets/sheetTypes.ts'
import type { AgentEntry, Session } from '../domains/identity/identityStore.ts'
import type { AgentRuntimeCandidate } from '../domains/agent/agentDetector.ts'

/**
 * pylonCliPorts — Pylon CLI 工具的接口面（B-8c 自 pylonCliService 拆出）：
 * 13 个 ControlPort（插件/钩子/命令/进程/工作区/注册表/包/Agent/会话/审批/交互/...）、
 * 工具输入输出 DTO 与 interaction wire 归一化。实现面（PylonCliService 装配与命令
 * 分发）仍在 pylonCliService，后者对消费面 re-export 本模块全部名字（import 面不变）。
 */
export type PylonCliCommand = string

export interface PylonCliInput {
  command: string
  args?: Record<string, unknown>
  timeoutMs?: number
}

export interface PylonCliToolOutput {
  ok: boolean
  result?: unknown
  error?: { code: string, message: string }
}

export interface PluginControlPort {
  snapshot(): {
    revision: number
    active: readonly PluginIdentity[]
    switches: readonly unknown[]
  }
  enable(pluginId: string): Promise<unknown>
  disable(pluginId: string): Promise<unknown>
  reload(pluginId: string, mode?: HotSwapMode): Promise<PluginUpdateResult>
}

export interface HookControlPort {
  list(): readonly {
    hookName: string
    handlerId: string
    pluginId: string
    runtimeInstanceId: string
    priority: number
    execution: string
    failurePolicy: string
  }[]
  trace(): readonly HookTraceEntry[]
}

export interface CommandControlPort {
  execute(commandId: string, args: unknown, options: { signal?: AbortSignal }): Promise<unknown>
  list(filter?: { ownerPluginIds?: readonly string[], executable?: boolean }): readonly unknown[]
  describe(commandId: string): unknown | null
}

export interface RegistryControlPort { snapshot(): unknown }

export interface PackageControlPort {
  list(): Promise<readonly unknown[]>
  inspect(sourcePath: string): Promise<unknown>
  installOrUpdate(sourcePath: string): Promise<{ ok: boolean, message?: string }>
  setEnabled(pluginId: string, enabled: boolean): Promise<{ ok: boolean, message?: string }>
  reload(pluginId: string): Promise<{ ok: boolean, message?: string }>
  versions(pluginId: string): Promise<readonly unknown[]>
  rollback(pluginId: string, packageInstanceId?: string): Promise<unknown>
  uninstall(pluginId: string, purgeData: boolean): Promise<{ ok: boolean, message?: string }>
}

export interface ProcessControlPort {
  list(runtimeInstanceId?: string): Promise<PluginProcessDescriptor[]>
  logs(processId: string, stream?: 'stdout' | 'stderr', limit?: number): Promise<PluginProcessLogEntry[]>
  terminate(processId: string): Promise<void>
}

export interface WorkspaceControlPort {
  list(): readonly SheetRecord[]
  open(input: {
    type: string
    title?: string
    state?: unknown
    agentId?: string
    singletonKey?: string
    pinned?: boolean
    metadata?: Record<string, string>
  }): string | null
  close(id: string): Promise<boolean>
}

/** CLI 增强：注册表工作区 CRUD（workspace_cmds 直通）。 */
export interface WorkspaceRegistryControlPort {
  list(): Promise<unknown>
  create(input: { agentId: string; name: string; rootPath: string }): Promise<unknown>
  update(input: { workspaceId: string; name?: string; rootPath?: string }): Promise<unknown>
  remove(workspaceId: string): Promise<unknown>
  search(query: string, maxResults?: number): Promise<unknown>
}

/** CLI 增强：会话级 config option（模型/思考档位等）与 journal 导出。 */
export interface SessionConfigControlPort {
  setOption(input: { agentId: string; sessionId: string; key: string; value: string }): Promise<unknown>
  exportSession(input: { agentId: string; periId: string; format: string; outputPath: string }): Promise<void>
}

export interface AgentControlPort {
  list(): Promise<{
    agents: readonly AgentEntry[]
    candidates: readonly AgentRuntimeCandidate[]
    catalog: readonly unknown[]
  }>
  import(input: { candidateId: string, agentId?: string }, options: { signal: AbortSignal }): Promise<unknown>
  setDefault(agentId: string, options: { signal: AbortSignal }): Promise<unknown>
}

export interface SessionControlPort {
  list(): Promise<readonly Session[]> | readonly Session[]
  /** CLI 增强：单会话实时状态（generating/liveStats）——观测维度补全。 */
  inspect(sessionId: string): Promise<unknown>
  create(input: {
    agentId?: string
    cwd?: string
    workspaceId?: string
    title?: string
  }, options: { signal: AbortSignal }): Promise<unknown>
  send(sessionId: string, content: string, options: { signal: AbortSignal }): Promise<unknown>
  close(sessionId: string, options: { signal: AbortSignal }): Promise<boolean>
  cancel(sessionId: string): Promise<boolean>
  /** CLI 增强：journal 消息查询（ownerKey 由 sessionId 推导；afterSeq 增量分页）。 */
  messages(sessionId: string, options: { afterSeq?: number; limit?: number; signal?: AbortSignal }): Promise<unknown>
}

/** #463 审查项 3：approval-mode wire 快照。`persisted` = 内存当前值是否已被
 *  SQLite 持有（或从未偏离持久层）——false 即 degraded（重启回退），外部可查。 */
export interface ApprovalModeSnapshot {
  mode: string
  persisted: boolean
}

export interface ApprovalControlPort {
  get(): Promise<ApprovalModeSnapshot>
  set(mode: string): Promise<ApprovalModeSnapshot>
}

/** interaction list 条目（respond 所需完整 identity + 展示字段）。
 *  `kind` 是 respond 必传的应答词项，来自后端投影（权限请求恒为 "approval"，
 *  见 permission.rs interaction_list）——透传，禁止硬编码（#36）。
 *  #423：后端改输出 wire 形状（统一队列 snapshot 单源投影），本形状由
 *  `normalizeWireInteractionEntry` 重建（对外表面不变，parity 测试钉住）；
 *  `deadlineMs` 因 wire 投影对无 deadline 条目输出 null 而放宽为可空。 */
export interface InteractionItem {
  provider: string
  agentId: string
  kind: string
  requestId: string
  sessionId: string
  toolCallId: string
  clientGeneration: number
  title: string
  prompt: string
  options: ReadonlyArray<{ optionId: string; kind?: string | null; name?: string | null }>
  requestedAt: string
  deadlineMs: number | null
}

/** #423：`interaction_list` 的 wire 条目（与 agent_status 的
 *  `pendingInteractions[]` 同一形状——统一队列 snapshot 的保形投影）。
 *  `payload` 是事件信封（eventType + 原始请求参数），与 `pylon:interaction`
 *  live 事件同构。 */
export interface WireInteractionEntry {
  requestId: string
  method: string
  kind: string
  sessionId: string
  agentId: string
  clientGeneration: number
  requestedAt: string
  state: string
  payload: unknown
  provider: string
  deadlineMs: number | null
}

/** #423 CLI 消费侧展示投影上限——超长 plan/question 摘要截断（自后端
 *  `PRIVATE_PROMPT_MAX_CHARS` 语义随迁，防超长文本撑爆列表）。 */
const INTERACTION_PROMPT_MAX_CHARS = 400

function truncateInteractionPrompt(text: string): string {
  const chars = Array.from(text)
  if (chars.length <= INTERACTION_PROMPT_MAX_CHARS) return text
  return `${chars.slice(0, INTERACTION_PROMPT_MAX_CHARS).join('')}…`
}

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** #423 快照面单源的 CLI 消费侧 normalize：wire 条目（队列 snapshot 投影）
 *  → `InteractionItem`（respond identity + 展示字段 + 应答 options 白名单）。
 *  与旧后端两 store 投影逐字段等价（见 `interactionWireNormalize.test.ts`
 *  parity 用例）：
 *  - permission.request → title/prompt/options/toolCallId 原文；
 *  - exit_plan → 虚拟 title "Exit plan"、options [approved/abandoned/
 *    keep_planning]、toolCallId 取 params；
 *  - elicitation → 虚拟 title "Elicitation"、options [accept/declined/cancel]；
 *  - ask-user → 虚拟 title "Ask user"、prompt 为 `id:question` 摘要
 *    （admit 时 minted question id 已回写进 wire payload——应答 values 的
 *    key 唯一来源）、options 留空（自由作答）。 */
export function normalizeWireInteractionEntry(entry: WireInteractionEntry): InteractionItem | null {
  const envelope = isPlainRecord(entry.payload) ? entry.payload : {}
  const body = isPlainRecord(envelope.payload) ? envelope.payload : {}
  const eventType = typeof envelope.eventType === 'string' ? envelope.eventType : ''
  let title: string
  let prompt: string
  let toolCallId = ''
  let options: ReadonlyArray<{ optionId: string; kind?: string | null; name?: string | null }> = []
  if (eventType === 'permission.request') {
    title = typeof body.title === 'string' ? body.title : ''
    prompt = typeof body.prompt === 'string' ? body.prompt : ''
    toolCallId = typeof envelope.toolCallId === 'string' ? envelope.toolCallId : ''
    options = Array.isArray(body.options)
      ? body.options.filter(isPlainRecord).map(option => ({
          optionId: String(option.optionId ?? ''),
          kind: typeof option.kind === 'string' ? option.kind : null,
          name: typeof option.name === 'string' ? option.name : null,
        })).filter(option => option.optionId.length > 0)
      : []
  } else if (entry.method === '_x.ai/exit_plan_mode') {
    title = 'Exit plan'
    prompt = typeof body.planContent === 'string' ? body.planContent : ''
    toolCallId = typeof body.toolCallId === 'string' ? body.toolCallId : ''
    options = ['approved', 'abandoned', 'keep_planning'].map(optionId => ({ optionId }))
  } else if (eventType === 'elicitation.request') {
    title = 'Elicitation'
    prompt = typeof body.message === 'string' ? body.message : ''
    options = ['accept', 'declined', 'cancel'].map(optionId => ({ optionId }))
  } else if (eventType === 'ask-user') {
    title = 'Ask user'
    // 摘要只统计 admit 时回写过 minted id 的问题（specs 有效条目——与旧后端
    // 「specs 缺省 → method 兜底」语义对齐）；id 是应答 values 的 key。
    const questions = Array.isArray(body.questions) ? body.questions.filter(isPlainRecord) : []
    const summary = questions
      .filter(question => typeof question.id === 'string' && question.id.length > 0)
      .map(question => `${question.id as string}:${typeof question.question === 'string' ? question.question : ''}`)
      .join('；')
    prompt = summary.length > 0 ? summary : entry.method
  } else {
    return null
  }
  return {
    provider: entry.provider,
    agentId: entry.agentId,
    kind: entry.kind,
    requestId: entry.requestId,
    sessionId: entry.sessionId,
    toolCallId,
    clientGeneration: entry.clientGeneration,
    title,
    // 私有桥沿用 400 字符截断（旧 PRIVATE_PROMPT_MAX_CHARS 语义随迁）；
    // permission prompt 保持原文（旧投影不截断）。
    prompt: eventType === 'permission.request' ? prompt : truncateInteractionPrompt(prompt),
    options,
    requestedAt: entry.requestedAt,
    deadlineMs: entry.deadlineMs,
  }
}

export interface InteractionControlPort {
  list(): Promise<{ items: readonly InteractionItem[] }>
  respond(identity: {
    provider: string
    agentId: string
    requestId: string
    sessionId: string
    toolCallId?: string | null
    clientGeneration: number
  }, kind: string, answer: { optionId?: string; text?: string; values?: unknown }): Promise<void>
}

export interface PylonCliServicePorts {
  plugins: PluginControlPort
  hooks: HookControlPort
  commands: CommandControlPort
  processes: ProcessControlPort
  workspaces: WorkspaceControlPort
  agents: AgentControlPort
  sessions: SessionControlPort
  registries: RegistryControlPort
  packages: PackageControlPort
  approval: ApprovalControlPort
  interactions: InteractionControlPort
  workspaceRegistry: WorkspaceRegistryControlPort
  sessionConfig: SessionConfigControlPort
  now?: () => number
  createOperationId?: () => string
}
