/**
 * OBS-07：P5 stderr 真实样本与"监控窗口"识别取证工具（方案书任务表 OBS-07，§11 完成判据 #8）。
 *
 * 目的：现场判定"用户所说监控窗口的具体窗口 + 真实 stderr 样本"，证据链第一手核验：
 *   - 窗口识别：单主窗口应用（src-tauri 无生产多窗口，WebviewWindowBuilder 仅测试）；唯一渲染
 *     运行日志的表面 = Runtime sheet（sheetRegistry.ts:10 'runtime' / sheetRegistry.tsx:54
 *     RuntimeSheetView）。用户所报"监控窗口"即 Runtime sheet。
 *   - stderr 双重写（历史，LOG-01 已消除）：每条 agent stderr 行曾以 A/B 两型各入 hub 一次——
 *       A 型（真实文本）：tracing::error!("{agent} stderr: {safe}") 被 RuntimeLogLayer 捕获
 *       B 型（固定标题）：hub.push_with_correlation("error", "agent-stderr", None,
 *          "Agent stderr output", {agent}, correlation) → 只含 agent，无行文本
 *     LOG-01 后 hub 唯一归属 = stderr reader 的显式 push（真实行文本 + category=stderr +
 *     code/rawAvailable），tracing 回声改走 agent_stderr_echo target 被 Layer 跳过（LOG-02
 *     再按行解析等级）。LOG-04：工具分流 POST-LOG-01 生产形态（hub 型 = source=agent-stderr
 *     + 真实行文本）与历史形态（A/B 型），双重写判定分母 = tracingLines+hubLines，新增
 *     levels（LOG-02 等级分布）+ codeCarrying（LOG-03 结构化 code 可观测性）支撑样本验收。
 *   - correlation：wire 恒携带（B1.2 身份）；曾因前端 normalizeRuntimeLogEntry 不映射而
 *     UI 不可见（P5 correlationDroppedFrontend=true），LOG-03 起 normalize 保留 correlation
 *     （该结构性常量翻转为 false）。
 *
 * 纪律（方案书 §2 阶段 M0）：只读取证；不修改任何业务语义；隔离生产路径（仅 DEV 钩子挂载，
 * 生产 tree-shake）；脱敏复用 OBS-04 sanitizeExportValue + OBS-05 narrowPathValues。
 * 数据源 = list_runtime_logs 原始 wire（≤2000 条，correlation 完整），不经前端 normalize
 * （取证需保留 wire 原始形态，直接核验 hub 内容）。
 */

import { sanitizeExportValue } from '../obs04/threeSourceExport'
import { narrowPathValues } from '../obs05/coldStartSnapshot'

/** 单 agent 样本上限 / 指纹上限（防工件膨胀，取证够用）。 */
export const MAX_SAMPLES_PER_AGENT = 20
export const MAX_FINGERPRINTS_PER_AGENT = 20

/**
 * 行内绝对路径收窄（CR-001 对齐增强）：样本行是散文（"error reading C:\Users\me\app\db"），
 * 整值 narrowPathValues 对"以路径形态开头"的整串有效，但行内嵌路径会泄漏。本函数对行内
 * 路径形态子串（盘符 / UNC / 根相对，≥2 段）整体替换为 `…/末段`，尾部标点剔除。
 * 与 obs05 narrowPathValues 语义对齐："/help" 单段不误伤、"C:/x" 盘符根收窄。
 */
const EMBEDDED_PATH_PATTERN = /[a-zA-Z]:[\\/][^\\/\s]+(?:[\\/][^\\/\s]+)*|(?:[\\/]{2})[^\\/\s]+[\\/][^\\/\s]+(?:[\\/][^\\/\s]+)*|[\\/][^\\/\s]+(?:[\\/][^\\/\s]+)+/g
const TRAILING_PUNCTUATION = /[.,;:)\]"'，。；：」』）]+$/

export function narrowEmbeddedPaths(line: string): string {
  return line.replace(EMBEDDED_PATH_PATTERN, (match) => {
    const trimmed = match.replace(TRAILING_PUNCTUATION, '')
    const segments = trimmed.replace(/[\\/]+$/, '').split(/[\\/]+/).filter(Boolean)
    if (segments.length < 2) return match
    // 日期形态（2026/08/14、5/10/2026）全段纯数字——非路径，豁免不误伤（CR-002，玉衡 NOTE）
    if (segments.every(segment => /^\d+$/.test(segment))) return match
    return `…/${segments[segments.length - 1]}`
  })
}

// ============================================================================
// wire 类型（list_runtime_logs 原始条目，correlation 保留）
// ============================================================================

export interface StderrWireEntry {
  id?: number | string
  timestamp?: number | string
  level?: string
  source?: string
  session?: string | null
  message: string
  fields?: Record<string, unknown> | null
  /** B1.2 会话身份（wire 恒携带；LOG-03 起前端 normalize 保留——UI 可见）。 */
  correlation?: unknown | null
  /** LOG-03 增量字段：结构化 JSON 顶层 code（agent 自报码，非 Pylon wire_code 词汇）。 */
  code?: string | null
  /** LOG-03 增量字段：集中词汇（stderr/frontend）；stderr reader 恒填 "stderr"。 */
  category?: string | null
  /** LOG-03 增量字段：真实行文本可用性（hub 显式 push 恒 true；历史 B 型占位符无）。 */
  rawAvailable?: boolean | null
}

/** 静态窗口证据（代码级登记，非运行时测量；与 OBS-06 结构性常量同模式）。 */
export const RUNTIME_WINDOW_EVIDENCE = {
  sheetKind: 'runtime',
  label: 'Runtime',
  renderKey: 'runtime-sheet',
  launchTitle: 'Runtime',
  description: '运行日志与启动诊断',
  renderer: 'RuntimeSheetView',
  singleWindowApp: true,
  note: '单主窗口应用（src-tauri 生产代码无 WebviewWindowBuilder，仅测试）；用户所报"监控窗口" = '
    + 'Runtime sheet（唯一渲染运行日志的表面）。',
  evidence: [
    'src/workspace-sheets/sheetRegistry.ts:10',
    'src/workspace-sheets/sheetRegistry.ts:40',
    'src/workspace-sheets/sheetRegistry.tsx:54',
  ],
} as const

// ============================================================================
// 分类与统计（纯函数，fixture 可测）
// ============================================================================

export type StderrEntryKind = 'tracing' | 'hub' | 'fixed-title' | 'none'

export interface StderrClassification {
  kind: StderrEntryKind
  agent: string | null
  /** 真实 stderr 行文本（tracing/hub 型；脱敏前原样）。 */
  line: string | null
}

/**
 * 分类（LOG-04：POST-LOG-01 生产形态与历史形态分流）：
 *  - hub        ：source === 'agent-stderr' 且 message 为真实行文本——LOG-01 后 hub 唯一
 *                 归属（stderr reader 显式 push，category=stderr + code + rawAvailable=true）
 *  - fixed-title：source === 'agent-stderr' 但 message 为历史占位符 "Agent stderr output"——
 *                 仅 LOG-01 前的 B 型历史样本（无行文本，agent 取自 fields.agent）
 *  - tracing    ：消息为 "{agent} stderr: {行}"（transport.rs:193 的 tracing::error! 经
 *                 RuntimeLogLayer 捕获；source 为模块 target，不依赖其拼写）——仅历史 A 型
 *  - none       ：其余（非 stderr 路径）
 */
export function classifyStderrEntry(entry: StderrWireEntry): StderrClassification {
  const source = typeof entry.source === 'string' ? entry.source : ''
  const message = typeof entry.message === 'string' ? entry.message : ''
  if (source === 'agent-stderr') {
    const agent = entry.fields && typeof entry.fields.agent === 'string' ? entry.fields.agent : null
    if (message === 'Agent stderr output') {
      // 历史 B 型占位符（无真实行文本）
      return { kind: 'fixed-title', agent, line: null }
    }
    // POST-LOG-01 生产形态：真实行文本承载于 message
    return { kind: 'hub', agent, line: message }
  }
  const match = /^(.+?) stderr: (.*)$/.exec(message)
  if (match) return { kind: 'tracing', agent: match[1], line: match[2] }
  return { kind: 'none', agent: null, line: null }
}

export interface AgentStderrStats {
  agent: string
  /** A 型条数（历史）：经 RuntimeLogLayer 捕获的 tracing 回声（hub ring 可能丢弃早于采集的行）。 */
  tracingLines: number
  /** LOG-01 后 hub 真实 stderr 行条数（source=agent-stderr 显式 push，真实行文本）。 */
  hubLines: number
  /** B 型条数（历史占位符 "Agent stderr output"，仅 LOG-01 前存在）。 */
  fixedTitle: number
  /** fixedTitle/(tracingLines+hubLines)；分母为 0 时 null。≈1 即双重写直接证据（历史）。 */
  ratio: number | null
  /** 携带 correlation 的 stderr 条目数（wire 身份可验证；含 tracing/hub/fixed-title 全类）。 */
  correlationPresent: number
  /** 携带非空 code（结构化 JSON 顶层 code，LOG-03）的 stderr 条目数。 */
  codeCarrying: number
  /** LOG-02 解析等级分布（hub 恒为解析等级；tracing/fixed-title 历史恒 error）。 */
  levels: { error: number; warn: number; info: number; debug: number }
  /** 真实 stderr 行样本（脱敏后，最近 MAX_SAMPLES_PER_AGENT 条，按时间升序）。 */
  samples: Array<{ at: number; line: string }>
  /** 同文本行指纹聚合（errorCenter 模式：{line,count,firstAt,lastAt}，按 count 降序）。 */
  fingerprints: Array<{ line: string; count: number; firstAt: number; lastAt: number }>
}

export interface StderrSampleSummary {
  /** A 型（历史 tracing 回声）总条数。 */
  totalLines: number
  /** LOG-01 后 hub 真实 stderr 行总条数（POST-LOG-01 生产形态的主计数）。 */
  hubLines: number
  /** B 型（历史固定标题占位符）总条数。 */
  totalFixedTitle: number
  agents: string[]
}

export function collectStderrSamples(entries: readonly StderrWireEntry[]): {
  summary: StderrSampleSummary
  perAgent: Record<string, AgentStderrStats>
} {
  const perAgent: Record<string, AgentStderrStats> = {}
  for (const entry of entries) {
    const classified = classifyStderrEntry(entry)
    if (classified.kind === 'none' || classified.agent === null) continue
    const stat = perAgent[classified.agent]
      ?? {
        agent: classified.agent,
        tracingLines: 0,
        hubLines: 0,
        fixedTitle: 0,
        ratio: null,
        correlationPresent: 0,
        codeCarrying: 0,
        levels: { error: 0, warn: 0, info: 0, debug: 0 },
        samples: [],
        fingerprints: [],
      }
    if (classified.kind === 'tracing') {
      stat.tracingLines += 1
      if (classified.line !== null) {
        stat.samples.push({ at: toTimestamp(entry.timestamp), line: classified.line })
      }
    } else if (classified.kind === 'hub') {
      stat.hubLines += 1
      if (classified.line !== null) {
        stat.samples.push({ at: toTimestamp(entry.timestamp), line: classified.line })
      }
    } else {
      // fixed-title（历史 B 型占位符）
      stat.fixedTitle += 1
    }
    // LOG-03 增量字段可观测性：结构化 JSON 顶层 code 是否到达 wire
    if (typeof entry.code === 'string' && entry.code.length > 0) stat.codeCarrying += 1
    if (entry.correlation !== undefined && entry.correlation !== null) stat.correlationPresent += 1
    // LOG-02 等级分布（hub 恒为解析等级；tracing/fixed-title 历史恒 error）
    const level = typeof entry.level === 'string' ? entry.level.toLowerCase() : ''
    if (level === 'error' || level === 'warn' || level === 'info' || level === 'debug') {
      stat.levels[level] += 1
    }
    perAgent[classified.agent] = stat
  }

  for (const stat of Object.values(perAgent)) {
    stat.ratio = stat.tracingLines + stat.hubLines > 0
      ? stat.fixedTitle / (stat.tracingLines + stat.hubLines)
      : null
    // 最近 N 条样本：list_runtime_logs 返回最新优先 wire（runtime_log.rs list 无条件 .iter().rev()），
    // samples 数组按 wire 序（新→旧）构建，取头部 N 条即每 agent 最近 N 条；再按时间升序呈现。
    // 逐行脱敏（secret 值 REDACTED）后行内绝对路径收窄（嵌路径形态子串 → …/末段）
    stat.samples = stat.samples
      .slice(0, MAX_SAMPLES_PER_AGENT)
      .map(sample => ({ at: sample.at, line: narrowEmbeddedPaths(sanitizeExportValue(sample.line) as string) }))
      .sort((a, b) => a.at - b.at)
    stat.fingerprints = buildFingerprints(stat.samples)
  }

  const agentList = Object.keys(perAgent).sort()
  const summary: StderrSampleSummary = {
    totalLines: agentList.reduce((sum, agent) => sum + perAgent[agent].tracingLines, 0),
    hubLines: agentList.reduce((sum, agent) => sum + perAgent[agent].hubLines, 0),
    totalFixedTitle: agentList.reduce((sum, agent) => sum + perAgent[agent].fixedTitle, 0),
    agents: agentList,
  }
  return { summary, perAgent }
}

function buildFingerprints(samples: Array<{ at: number; line: string }>): AgentStderrStats['fingerprints'] {
  const groups = new Map<string, { count: number; firstAt: number; lastAt: number }>()
  for (const sample of samples) {
    const group = groups.get(sample.line) ?? { count: 0, firstAt: sample.at, lastAt: sample.at }
    group.count += 1
    group.firstAt = Math.min(group.firstAt, sample.at)
    group.lastAt = Math.max(group.lastAt, sample.at)
    groups.set(sample.line, group)
  }
  return [...groups.entries()]
    .map(([line, group]) => ({ line, count: group.count, firstAt: group.firstAt, lastAt: group.lastAt }))
    .sort((a, b) => b.count - a.count || a.firstAt - b.firstAt)
    .slice(0, MAX_FINGERPRINTS_PER_AGENT)
}

function toTimestamp(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const numeric = Number(value)
    return Number.isFinite(numeric) ? numeric : Date.parse(value)
  }
  return 0
}

// ============================================================================
// P5 判定与工件组装
// ============================================================================

export interface P5Checks {
  /** 窗口识别证据（静态登记，附文件行号）。 */
  windowIdentified: typeof RUNTIME_WINDOW_EVIDENCE
  /** 双重写实证（历史）：存在任一 agent 同时有 B 型（固定标题）与真实行条目（A 型 + hub）。 */
  doubleWriteConfirmed: boolean
  /** 结构性常量：前端 normalize 是否丢弃 correlation。LOG-03 起 normalize 保留
   * （runtimeLogContracts.toCorrelation）→ false；历史 OBS-07 工件为 true（P5 证据）。
   * 取证仍读原始 wire（不经 normalize），该常量只登记前端契约状态。 */
  correlationDroppedFrontend: false
  /** 真实 stderr 行文本是否到达 hub（totalLines + hubLines > 0）。 */
  samplesAvailable: boolean
  /** 观察到的真实 stderr 行总数（A 型 + hub；B 型占位符不计）。 */
  totalStderrLines: number
}

export function buildP5Checks(input: {
  summary: StderrSampleSummary
  perAgent: Record<string, AgentStderrStats>
}): P5Checks {
  const doubleWriteConfirmed = Object.values(input.perAgent).some(
    stat => stat.fixedTitle > 0 && stat.tracingLines + stat.hubLines > 0,
  )
  const totalStderrLines = input.summary.totalLines + input.summary.hubLines
  return {
    windowIdentified: RUNTIME_WINDOW_EVIDENCE,
    doubleWriteConfirmed,
    correlationDroppedFrontend: false,
    samplesAvailable: totalStderrLines > 0,
    totalStderrLines,
  }
}

export interface StderrSamplesArtifact {
  tool: 'obs07-stderr-samples'
  /** LOG-04：perAgent 增 hubLines/levels/codeCarrying、summary 增 hubLines、P5 判定分母含 hub。 */
  schemaVersion: 2
  capturedAt: number
  phase: string
  summary: StderrSampleSummary
  perAgent: Record<string, AgentStderrStats>
  p5Checks: P5Checks
}

/** 编排：分类统计 → P5 判定 → 工件；脱敏后整体绝对路径收窄（obs05 narrowPathValues 复用）。 */
export function buildStderrSamplesArtifact(input: {
  phase: string
  entries: readonly StderrWireEntry[]
}): StderrSamplesArtifact {
  const { summary, perAgent } = collectStderrSamples(input.entries)
  const artifact: StderrSamplesArtifact = {
    tool: 'obs07-stderr-samples',
    schemaVersion: 2,
    capturedAt: Date.now(),
    phase: input.phase,
    summary,
    perAgent,
    p5Checks: buildP5Checks({ summary, perAgent }),
  }
  return narrowPathValues(sanitizeExportValue(artifact)) as StderrSamplesArtifact
}
