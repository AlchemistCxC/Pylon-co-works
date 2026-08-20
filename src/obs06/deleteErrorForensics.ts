/**
 * OBS-06：P4 删除错误与 readiness 采集取证工具（方案书任务表 OBS-06，§11 完成判据 P4）。
 *
 * 目的：删除会话失败时采集完整结构化错误对象（{code,message} wire）+ 数据库 readiness
 * 状态 + 删除路径 + 重试结果，供 P4（删除会话未知错误，方案书 §1.5 / §9 缺口 #7）现场
 * 判定"未知错误 code"与未就绪来源。
 *
 * 已知错误码（src-tauri 实测，B1.2 结构化 wire {code,message}）：
 *   UserDataError：user_data_revision_conflict / user_data_unavailable / user_data_corrupt /
 *                  user_data_not_found
 *   MessageError ：message_repo_corrupt / message_repo_constraint / message_repo_conflict /
 *                  message_db_unavailable
 *   EventError   ：event_revision_conflict / event_repo_corrupt / event_repo_constraint /
 *                  event_repo_conflict / event_db_unavailable / event_invalid /
 *                  event_session_deleted
 *
 * 只读取证（M0 纪律，方案书 §2）：不修改删除事务、不主动触发删除；经 invoke 只读包裹
 * 被动记录真实删除路径（close_session → user_session_delete → evt_append 等）的
 * wire 调用与结算结果；readiness 探测用只读命令（evt_revision / user_data_load）。
 * 全链路 DEV-only：生产 tree-shake 零暴露，与 OBS-04/05 同一隔离模式。
 */

import { sanitizeExportValue, resolveSessionIdentity, collectSqliteSection, collectLocalStorageSection } from '../obs04/threeSourceExport'
import { toCanonicalOwnerKey } from '../domains/events/eventSchema'
import { narrowPathValues } from '../obs05/coldStartSnapshot'

/** 已证实结构化错误码全集（B1.2，src-tauri 稳定拼写；B7 后以 evt_* 为 canonical 迟到写路径）。 */
export const KNOWN_DELETE_ERROR_CODES = [
  'user_data_revision_conflict', 'user_data_unavailable', 'user_data_corrupt', 'user_data_not_found',
  'message_repo_corrupt', 'message_repo_constraint', 'message_repo_conflict', 'message_db_unavailable',
  'event_revision_conflict', 'event_repo_corrupt', 'event_repo_constraint', 'event_repo_conflict',
  'event_db_unavailable', 'event_invalid', 'event_session_deleted',
] as const

export interface DeleteInvokeOutcome {
  seq: number
  at: number
  cmd: string
  /** 脱敏后的 args（secret 形态值 REDACTED、敏感 key 剔除、绝对路径收窄）。 */
  args: unknown
  ok: boolean
  /** 结算失败时 B1.2 wire 的 code；非结构化失败（Error/string）为 null。 */
  code?: string | null
  /** 结算失败时展示层 message（脱敏）。 */
  message?: string | null
}

export interface DeleteTrace {
  push(cmd: string, args: unknown): DeleteInvokeOutcome
  settle(entry: DeleteInvokeOutcome, error: unknown): void
  snapshot(): DeleteTraceSection
  stop(): void
  enabled: boolean
}

export interface DeleteTraceSection {
  enabled: boolean
  startAt: number | null
  endAt: number | null
  count: number
  /** ring 超限后最早记录被丢弃。 */
  truncated: boolean
  entries: DeleteInvokeOutcome[]
}

/** readiness 探测结果（只读命令推断，非后端显式状态——后端不向前端暴露 readiness）。 */
export type ReadinessState = 'ready' | 'unavailable' | 'unknown'

export interface ReadinessProbe {
  service: 'event' | 'user_data'
  probeCmd: string
  ok: boolean
  code?: string | null
  state: ReadinessState
}

export interface ReadinessSection {
  event: ReadinessState
  userData: ReadinessState
  probes: ReadinessProbe[]
}

/** P4 结构判定（仅记录/文档证据，不断言运行态时序）。 */
export interface P4Checks {
  /** 删除路径上出现的、不在 KNOWN_DELETE_ERROR_CODES 的错误码（"未知错误"直接证据）。 */
  unknownErrorCodes: Array<{ cmd: string; code: string; message?: string | null }>
  /** 结算失败为 user_data_unavailable / event_db_unavailable / message_db_unavailable（readiness 未就绪推断）。 */
  unreadyServiceOnDelete: boolean
  /** 结构性常量：delete_session_core 把会话删除的 MessageError 折叠为 user_data_unavailable
   * （src-tauri/src/session/mod.rs）——message_repo_* 类 code 到前端前已丢失。 */
  cascadeCodeFoldedServerSide: true
  /** 结构性常量：user_data_not_found 在 core 内被吸收（mod.rs:735 幂等补删），前端不可见。 */
  notFoundToleranceServerSide: true
  /** 结构性常量：结构化 error 的 code 未保留到 UI——removeSessionTransaction 仅取 message；
   * formatRuntimeError 已能提取 {code,message} 对象并在 message 不含 code 时加前缀。 */
  uiPreservesErrorCode: false
}

export interface DeleteForensicsArtifact {
  tool: 'obs06-delete-error-forensics'
  schemaVersion: 1
  capturedAt: number
  phase: string
  sessionId: string
  readiness: ReadinessSection
  deleteTrace: DeleteTraceSection
  /** 失败现场残留状态（三源只读采集，复用 OBS-04）。 */
  residual: {
    identity: ReturnType<typeof resolveSessionIdentity>
    sqlite: Awaited<ReturnType<typeof collectSqliteSection>> | null
    localStorage: ReturnType<typeof collectLocalStorageSection> | null
  }
  p4Checks: P4Checks
}

export interface Obs06Transport {
  invoke: (cmd: string, args?: Record<string, unknown> | undefined) => Promise<unknown>
}

export interface Obs06Storage {
  getItem(key: string): string | null
}

const RING_CAP = 200

/** 结算错误 → B1.2 {code,message} 提取（结构化 wire）；非结构化错误返回 null code。 */
export function extractStructuredError(error: unknown): { code?: string | null; message?: string | null } {
  if (error && typeof error === 'object') {
    const record = error as { code?: unknown; message?: unknown }
    if (typeof record.code === 'string') {
      return {
        code: record.code,
        message: typeof record.message === 'string' ? record.message : null,
      }
    }
    // 嵌套在 Error 上的结构化字段（部分 transport 包装）
    if (record.code !== undefined && typeof (error as { error?: unknown }).error === 'object') {
      return extractStructuredError((error as { error: unknown }).error)
    }
  }
  if (error instanceof Error) {
    return { code: null, message: error.message }
  }
  return { code: null, message: typeof error === 'string' ? error : null }
}

/** 删除路径 invoke 只读 trace：记录请求 + 结算结果；透传原 promise 不变。 */
export function createDeleteTrace(): DeleteTrace {
  let stopped = false
  let seq = 0
  let startAt: number | null = null
  let endAt: number | null = null
  const ring: DeleteInvokeOutcome[] = []

  const push = (cmd: string, args: unknown): DeleteInvokeOutcome => {
    if (stopped) return dummyEntry(cmd)
    if (startAt === null) startAt = Date.now()
    const entry: DeleteInvokeOutcome = {
      seq: ++seq,
      at: Date.now(),
      cmd,
      args: sanitizeExportValue(args),
      ok: false,
      code: null,
      message: null,
    }
    if (ring.length >= RING_CAP) ring.shift()
    ring.push(entry)
    return entry
  }

  const settle = (entry: DeleteInvokeOutcome, error: unknown): void => {
    if (stopped) return
    const found = ring.find(candidate => candidate === entry)
    if (!found) return
    if (error === undefined || error === null) {
      entry.ok = true
      entry.code = null
      entry.message = null
    } else {
      entry.ok = false
      const structured = extractStructuredError(error)
      entry.code = structured.code ?? null
      entry.message = sanitizeExportValue(structured.message) as string | null
    }
  }

  return {
    get enabled() { return !stopped },
    push,
    settle,
    snapshot: () => ({
      enabled: !stopped,
      startAt,
      endAt,
      count: ring.length,
      truncated: seq > RING_CAP,
      entries: ring.slice(),
    }),
    stop: () => {
      stopped = true
      endAt = Date.now()
    },
  }
}

/** stopped 后的 push 占位 entry（绝不落 ring，防止对象身份误配）。 */
function dummyEntry(cmd: string): DeleteInvokeOutcome {
  return { seq: 0, at: 0, cmd, args: null, ok: false, code: null, message: null }
}

/**
 * 只读包裹 window.__TAURI_INTERNALS__.invoke：记录 (cmd, args) 后调用原函数，返回
 * 原始 promise（透传零行为变化）；结算时经 .then/.catch 记录 ok/code/message。
 * 与既有包裹（OBS-05 __obs05Wrapped）可组合：读取当前最外层 invoke，幂等防二次包裹。
 * 无法获取 invoke（浏览器 mock）→ false。
 */
export function installDeleteForensicsWrapper(trace: DeleteTrace): boolean {
  if (typeof window === 'undefined') return false
  const internals = (window as unknown as { __TAURI_INTERNALS__?: { invoke?: unknown } }).__TAURI_INTERNALS__
  if (!internals || typeof internals.invoke !== 'function') return false
  const original = internals.invoke as (cmd: string, args?: unknown, options?: unknown) => Promise<unknown>
  if ((original as unknown as { __obs06Wrapped?: boolean }).__obs06Wrapped) return true
  const wrapped = ((cmd: string, args?: unknown, options?: unknown) => {
    const entry = trace.push(cmd, args)
    const promise = original(cmd, args, options)
    // 不返回派生 promise，保留原对象；仅旁路记录结算结果
    void Promise.resolve(promise).then(
      () => trace.settle(entry, undefined),
      (error) => trace.settle(entry, error),
    )
    return promise
  }) as typeof original
  ;(wrapped as unknown as { __obs06Wrapped?: boolean }).__obs06Wrapped = true
  internals.invoke = wrapped
  return true
}

// ============================================================================
// readiness 探测与 P4 判定（依赖注入，fixture 可测）
// ============================================================================

/**
 * readiness 探测：用只读命令推断两个服务槽位是否已填充（后端不向前端暴露 readiness 状态）。
 *  - event    槽位：evt_revision{ownerKey} —— 槽位 None → event_db_unavailable
 *  - user_data 槽位：user_data_load{key}    —— 槽位 None → user_data_unavailable
 * 任一探测自身失败（非未就绪 code）→ state=unknown（不臆断）。
 * 探测走原始 transport 直调（不经包裹 trace，避免污染删除路径证据）。
 */
export async function probeReadiness(transport: Obs06Transport): Promise<ReadinessSection> {
  const probes: ReadinessProbe[] = []

  const probe = async (service: 'event' | 'user_data', probeCmd: string, args: Record<string, unknown>): Promise<void> => {
    let ok = false
    let code: string | null = null
    try {
      await transport.invoke(probeCmd, args)
      ok = true
    } catch (error) {
      const structured = extractStructuredError(error)
      code = structured.code ?? null
    }
    const unready = code === 'event_db_unavailable' || code === 'user_data_unavailable' || code === 'message_db_unavailable'
    probes.push({
      service,
      probeCmd,
      ok,
      code,
      state: ok ? 'ready' : unready ? 'unavailable' : 'unknown',
    })
  }

  await probe('event', 'evt_revision', { ownerKey: '__obs06_readiness_probe__' })
  await probe('user_data', 'user_data_load', { key: 'sessions' })

  const event = probes.find(p => p.service === 'event')?.state ?? 'unknown'
  const userData = probes.find(p => p.service === 'user_data')?.state ?? 'unknown'
  return { event, userData, probes }
}

/** P4 结构判定：未知错误码 / readiness 未就绪信号 / NotFound 容忍 / UI code 保留。 */
export function buildP4Checks(input: {
  trace: DeleteTraceSection
  readiness: ReadinessSection
}): P4Checks {
  const unknownErrorCodes: Array<{ cmd: string; code: string; message?: string | null }> = []
  let unreadyServiceOnDelete = false

  for (const entry of input.trace.entries) {
    if (entry.ok) continue
    const code = entry.code
    if (!code) continue
    if (!KNOWN_DELETE_ERROR_CODES.includes(code as (typeof KNOWN_DELETE_ERROR_CODES)[number])) {
      unknownErrorCodes.push({ cmd: entry.cmd, code, message: entry.message ?? null })
    }
    if (code === 'user_data_unavailable' || code === 'event_db_unavailable' || code === 'message_db_unavailable') {
      unreadyServiceOnDelete = true
    }
  }

  return {
    unknownErrorCodes,
    unreadyServiceOnDelete,
    cascadeCodeFoldedServerSide: true,
    notFoundToleranceServerSide: true,
    // 结构性常量（removeSessionTransaction.ts:29,36 只取 error.message；runtimeError.ts:8-14
    // 对非 Error 对象输出"未知错误"，code 未向上传递）
    uiPreservesErrorCode: false,
  }
}

/**
 * 编排：readiness 探测 + 删除路径 trace + 失败现场残留三源采集（复用 OBS-04 只读
 * collect*）+ P4 判定。任一路失败不影响其他（各带独立失败态）。
 */
export async function buildDeleteForensicsArtifact(input: {
  phase: string
  sessionId: string
  transport: Obs06Transport
  storage: Obs06Storage
  trace: DeleteTraceSection
}): Promise<DeleteForensicsArtifact> {
  const { phase, sessionId, transport, storage, trace } = input
  const readiness = await probeReadiness(transport)
  const p4Checks = buildP4Checks({ trace, readiness })
  // 残留三源采集：单源失败不拖垮整体（如 evt_list 未就绪拒绝 → sqlite 降级失败态）
  let identity: ReturnType<typeof resolveSessionIdentity> = null
  let sqlite: Awaited<ReturnType<typeof collectSqliteSection>> | null = null
  let localStorage: ReturnType<typeof collectLocalStorageSection> | null = null
  try { identity = resolveSessionIdentity(sessionId, storage) } catch { /* 保持 null */ }
  if (identity?.profileId && identity?.agentId && identity?.source) {
    const ownerKey = toCanonicalOwnerKey({
      profileId: identity.profileId,
      agentId: identity.agentId,
      localSessionId: identity.source,
    })
    try { sqlite = await collectSqliteSection({ sessionId, ownerKey, transport }) } catch { /* 保持 null */ }
  }
  try { localStorage = collectLocalStorageSection(sessionId, storage) } catch { /* 保持 null */ }
  const artifact: DeleteForensicsArtifact = {
    tool: 'obs06-delete-error-forensics',
    schemaVersion: 1,
    capturedAt: Date.now(),
    phase,
    sessionId,
    readiness,
    deleteTrace: trace,
    residual: { identity, sqlite, localStorage },
    p4Checks,
  }
  // CR-001 对齐：脱敏后整体绝对路径收窄（cwd/workdir/ipc 路径形态，复用 obs05 narrowPathValues）
  return narrowPathValues(sanitizeExportValue(artifact)) as DeleteForensicsArtifact
}
