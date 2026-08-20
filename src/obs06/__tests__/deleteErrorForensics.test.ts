/**
 * OBS-06：P4 删除错误与 readiness 采集取证工具单元测试。
 *
 * 覆盖：结构化错误提取（B1.2 {code,message} wire）；删除路径 invoke trace（ring 上限、
 * stop、脱敏、结算结果记录）；wrapper 幂等安装与透传；readiness 探测（只读命令推断）；
 * P4 结构判定（未知错误码/未就绪信号/服务端折叠常量）；工件组装（单源失败不拖垮 + 绝对
 * 路径收窄）。
 */

import { describe, expect, it, vi } from 'vitest'
import {
  KNOWN_DELETE_ERROR_CODES,
  buildDeleteForensicsArtifact,
  buildP4Checks,
  createDeleteTrace,
  extractStructuredError,
  installDeleteForensicsWrapper,
  probeReadiness,
  type Obs06Storage,
  type Obs06Transport,
  type ReadinessSection,
  type DeleteTraceSection,
} from '../deleteErrorForensics'

function memoryStorage(entries: Record<string, string>): Obs06Storage {
  return {
    getItem: (key: string) => entries[key] ?? null,
  }
}

function makeTransport(handler: (cmd: string, args: Record<string, unknown>) => Promise<unknown>): Obs06Transport {
  return {
    invoke: (cmd, args) => handler(cmd, args ?? {}),
  }
}

function makeTraceSection(entries: Array<{ cmd: string; ok: boolean; code?: string | null; message?: string | null }>): DeleteTraceSection {
  return {
    enabled: true,
    startAt: 1,
    endAt: 2,
    count: entries.length,
    truncated: false,
    entries: entries.map((entry, index) => ({
      seq: index + 1,
      at: 1 + index,
      cmd: entry.cmd,
      args: null,
      ok: entry.ok,
      code: entry.code ?? null,
      message: entry.message ?? null,
    })),
  }
}

// ── 结构化错误提取 ────────────────────────────────────────────────────────────

describe('extractStructuredError', () => {
  it('B1.2 wire {code,message} 对象提取', () => {
    const structured = extractStructuredError({ code: 'user_data_unavailable', message: '用户数据仓库不可用：x' })
    expect(structured.code).toBe('user_data_unavailable')
    expect(structured.message).toContain('用户数据仓库不可用')
  })

  it('嵌套 error 对象递归提取；Error 实例 code=null；字符串 message 兜底', () => {
    expect(extractStructuredError({ code: 'event_session_deleted', error: { message: 'nested' } }).code).toBe('event_session_deleted')
    const fromError = extractStructuredError(new Error('boom'))
    expect(fromError.code).toBeNull()
    expect(fromError.message).toBe('boom')
    expect(extractStructuredError('plain string').message).toBe('plain string')
  })

  it('非结构化输入 → code=null', () => {
    expect(extractStructuredError(42).code).toBeNull()
    expect(extractStructuredError(null).message).toBeNull()
  })
})

// ── 删除路径 trace ────────────────────────────────────────────────────────────

describe('createDeleteTrace', () => {
  it('push/settle 记录请求与结算结果；snapshot 汇总', () => {
    const trace = createDeleteTrace()
    const entry = trace.push('user_session_delete', { sessionId: 's1' })
    expect(entry.ok).toBe(false)
    trace.settle(entry, { code: 'user_data_unavailable', message: 'user data db unavailable' })
    const section = trace.snapshot()
    expect(section.count).toBe(1)
    expect(section.entries[0].ok).toBe(false)
    expect(section.entries[0].code).toBe('user_data_unavailable')
  })

  it('settle 成功 → ok=true', () => {
    const trace = createDeleteTrace()
    const entry = trace.push('close_session', { source: 'local:s1' })
    trace.settle(entry, undefined)
    expect(trace.snapshot().entries[0].ok).toBe(true)
  })

  it('stop 后 push/settle 不再记录；enabled getter 同步（CR-002 模式对齐）', () => {
    const trace = createDeleteTrace()
    expect(trace.enabled).toBe(true)
    const entry = trace.push('evt_list', {})
    trace.settle(entry, undefined)
    trace.stop()
    expect(trace.enabled).toBe(false)
    const late = trace.push('user_session_delete', {})
    trace.settle(late, { code: 'x' })
    expect(trace.snapshot().count).toBe(1)
    expect(trace.snapshot().enabled).toBe(false)
  })

  it('ring 上限：超出截断并置 truncated', () => {
    const trace = createDeleteTrace()
    for (let i = 0; i < 210; i += 1) {
      trace.settle(trace.push('evt_revision', { i }), undefined)
    }
    const section = trace.snapshot()
    expect(section.count).toBe(200)
    expect(section.truncated).toBe(true)
  })

  it('args 脱敏在 push 时应用（apiKey 剔除、sk- 值 REDACTED）', () => {
    const trace = createDeleteTrace()
    const entry = trace.push('user_session_delete', { sessionId: 's1', apiKey: 'sk-leak', rawOutput: 'x' })
    const json = JSON.stringify(entry.args)
    expect(json).not.toContain('sk-leak')
    expect(json).not.toContain('apiKey')
    expect(json).not.toContain('rawOutput')
    expect((entry.args as Record<string, unknown>).sessionId).toBe('s1')
  })
})

// ── wrapper 幂等安装 ────────────────────────────────────────────────────────

describe('installDeleteForensicsWrapper', () => {
  it('无 window（node 环境）→ false', () => {
    expect(installDeleteForensicsWrapper(createDeleteTrace())).toBe(false)
  })

  it('包裹并透传原 promise；结算结果记录 ok/error；幂等二次安装不重复包裹', async () => {
    const calls: string[] = []
    const original = async (cmd: string, args?: unknown) => {
      calls.push(cmd)
      if (cmd === 'user_session_delete') throw { code: 'user_data_unavailable', message: 'unready' }
      return { ok: true, args }
    }
    const fakeWindow = { __TAURI_INTERNALS__: { invoke: original } }
    const previous = globalThis.window
    vi.stubGlobal('window', fakeWindow)
    try {
      const trace = createDeleteTrace()
      expect(installDeleteForensicsWrapper(trace)).toBe(true)
      expect(installDeleteForensicsWrapper(trace)).toBe(true) // 幂等
      const internals = (fakeWindow.__TAURI_INTERNALS__.invoke as (cmd: string, args?: unknown) => Promise<unknown>)
      const okResult = await internals('evt_list', { ownerKey: '["p","a","s1"]' })
      expect(okResult).toEqual({ ok: true, args: { ownerKey: '["p","a","s1"]' } })
      await expect(internals('user_session_delete', { sessionId: 's1' })).rejects.toMatchObject({ code: 'user_data_unavailable' })
      const section = trace.snapshot()
      expect(section.count).toBe(2)
      expect(section.entries[0].cmd).toBe('evt_list')
      expect(section.entries[0].ok).toBe(true)
      expect(section.entries[1].cmd).toBe('user_session_delete')
      expect(section.entries[1].ok).toBe(false)
      expect(section.entries[1].code).toBe('user_data_unavailable')
      // 原始 promise 透传（返回值不换 promise 实例）
      expect(calls).toEqual(['evt_list', 'user_session_delete'])
    } finally {
      if (previous === undefined) vi.unstubAllGlobals()
      else vi.stubGlobal('window', previous)
    }
  })

  it('与既有包裹（__obs05Wrapped 形态）可组合：包裹当前最外层 invoke', async () => {
    let outerCalls = 0
    const original = async () => { outerCalls += 1; return { ok: true } }
    ;(original as unknown as { __obs05Wrapped?: boolean }).__obs05Wrapped = true
    const fakeWindow = { __TAURI_INTERNALS__: { invoke: original } }
    const previous = globalThis.window
    vi.stubGlobal('window', fakeWindow)
    try {
      const trace = createDeleteTrace()
      expect(installDeleteForensicsWrapper(trace)).toBe(true)
      const internals = (fakeWindow.__TAURI_INTERNALS__.invoke as (cmd: string, args?: unknown) => Promise<unknown>)
      await internals('user_session_delete', {})
      expect(outerCalls).toBe(1)
      expect(trace.snapshot().count).toBe(1)
      // 二次安装仍是同一个 obs06 包裹（防二次包裹标记）
      expect((fakeWindow.__TAURI_INTERNALS__.invoke as unknown as { __obs06Wrapped?: boolean }).__obs06Wrapped).toBe(true)
    } finally {
      if (previous === undefined) vi.unstubAllGlobals()
      else vi.stubGlobal('window', previous)
    }
  })
})

// ── readiness 探测 ────────────────────────────────────────────────────────────

describe('probeReadiness', () => {
  it('两服务就绪 → ready/ready，probes 各带 code=null', async () => {
    const transport = makeTransport(async () => ({ ok: true }))
    const section = await probeReadiness(transport)
    expect(section.event).toBe('ready')
    expect(section.userData).toBe('ready')
    expect(section.probes).toHaveLength(2)
    expect(section.probes.every(probe => probe.code === null)).toBe(true)
  })

  it('未就绪 → unavailable（evt_revision 拒绝 event_db_unavailable / user_data_load 拒绝 user_data_unavailable）', async () => {
    const transport = makeTransport(async (cmd) => {
      if (cmd === 'evt_revision') throw { code: 'event_db_unavailable', message: 'event db unavailable' }
      if (cmd === 'user_data_load') throw { code: 'user_data_unavailable', message: 'user data db unavailable' }
      return null
    })
    const section = await probeReadiness(transport)
    expect(section.event).toBe('unavailable')
    expect(section.userData).toBe('unavailable')
  })

  it('非未就绪拒绝 → unknown（不臆断）', async () => {
    const transport = makeTransport(async () => { throw { code: 'event_repo_corrupt', message: 'corrupt' } })
    const section = await probeReadiness(transport)
    expect(section.event).toBe('unknown')
    expect(section.userData).toBe('unknown')
  })
})

// ── P4 结构判定 ────────────────────────────────────────────────────────────────

describe('buildP4Checks', () => {
  const readiness: ReadinessSection = { event: 'ready', userData: 'ready', probes: [] }

  it('未知错误码登记（不在 KNOWN_DELETE_ERROR_CODES 内）；已知码不误报', () => {
    const trace = makeTraceSection([
      { cmd: 'user_session_delete', ok: false, code: 'mystery_code_9', message: '?' },
      { cmd: 'evt_append', ok: false, code: 'event_session_deleted', message: '会话已删除' },
      { cmd: 'evt_list', ok: true },
    ])
    const checks = buildP4Checks({ trace, readiness })
    expect(checks.unknownErrorCodes).toHaveLength(1)
    expect(checks.unknownErrorCodes[0].cmd).toBe('user_session_delete')
    expect(checks.unknownErrorCodes[0].code).toBe('mystery_code_9')
  })

  it('unreadyServiceOnDelete：user_data_unavailable / event_db_unavailable 触发', () => {
    const trace = makeTraceSection([
      { cmd: 'user_session_delete', ok: false, code: 'user_data_unavailable' },
      { cmd: 'evt_revision', ok: false, code: 'event_db_unavailable' },
    ])
    expect(buildP4Checks({ trace, readiness }).unreadyServiceOnDelete).toBe(true)
  })

  it('服务端折叠/NotFound 容忍/UI code 保留为结构性常量', () => {
    const checks = buildP4Checks({ trace: makeTraceSection([]), readiness })
    expect(checks.cascadeCodeFoldedServerSide).toBe(true)
    expect(checks.notFoundToleranceServerSide).toBe(true)
    expect(checks.uiPreservesErrorCode).toBe(false)
  })

  it('KNOWN_DELETE_ERROR_CODES 覆盖 UserDataError + MessageError + EventError 全集（B1.2）', () => {
    const expected = [
      'user_data_revision_conflict', 'user_data_unavailable', 'user_data_corrupt', 'user_data_not_found',
      'message_repo_corrupt', 'message_repo_constraint', 'message_repo_conflict', 'message_db_unavailable',
      'event_revision_conflict', 'event_repo_corrupt', 'event_repo_constraint', 'event_repo_conflict',
      'event_db_unavailable', 'event_invalid', 'event_session_deleted',
    ]
    expect([...KNOWN_DELETE_ERROR_CODES]).toEqual(expected)
  })
})

// ── 工件组装 ──────────────────────────────────────────────────────────────────

describe('buildDeleteForensicsArtifact', () => {
  it('readiness + trace + 残留三源 + P4 判定组装；phase 标注', async () => {
    const storage = memoryStorage({
      'pylon-msgs-s9': JSON.stringify({ version: 1, messages: [] }),
      'pylon-sessions': JSON.stringify({ version: 2, sessions: [{ id: 's9', agentId: 'peri', profileId: 'p', source: 'local:s9', periId: 'peri-9', workdir: 'G:/work/prism-desktop', createdAt: 1, lastActiveAt: 2 }] }),
    })
    const transport = makeTransport(async (cmd) => {
      if (cmd === 'evt_revision') return 0
      if (cmd === 'evt_list') return { events: [], nextBeforeSequence: null }
      if (cmd === 'user_data_load') return null
      return null
    })
    const trace = makeTraceSection([
      { cmd: 'user_session_delete', ok: false, code: 'user_data_unavailable', message: 'user data db unavailable' },
    ])
    const artifact = await buildDeleteForensicsArtifact({ phase: 'diagnose', sessionId: 's9', transport, storage, trace })
    expect(artifact.tool).toBe('obs06-delete-error-forensics')
    expect(artifact.phase).toBe('diagnose')
    expect(artifact.readiness.event).toBe('ready')
    expect(artifact.readiness.userData).toBe('ready')
    expect(artifact.deleteTrace.entries[0].code).toBe('user_data_unavailable')
    expect(artifact.p4Checks.unreadyServiceOnDelete).toBe(true)
    expect(artifact.residual.identity?.agentId).toBe('peri')
    // 绝对路径收窄（identity.workdir）
    expect(artifact.residual.identity?.workdir).toBe('…/prism-desktop')
    const json = JSON.stringify(artifact)
    expect(json).not.toContain('G:/work')
    expect(json).toContain('…/prism-desktop')
  })

  it('单源失败不拖垮：evt_list 未就绪拒绝 → sqlite 为 null，其余正常', async () => {
    const storage = memoryStorage({
      'pylon-sessions': JSON.stringify({ version: 2, sessions: [{ id: 's9', agentId: 'peri', profileId: 'p', source: 'local:s9', createdAt: 1, lastActiveAt: 2 }] }),
    })
    const transport = makeTransport(async (cmd) => {
      if (cmd === 'evt_list' || cmd === 'evt_revision') throw { code: 'event_db_unavailable', message: 'unready' }
      if (cmd === 'user_data_load') throw { code: 'user_data_unavailable', message: 'unready' }
      return null
    })
    const trace = makeTraceSection([])
    const artifact = await buildDeleteForensicsArtifact({ phase: 'diagnose', sessionId: 's9', transport, storage, trace })
    expect(artifact.residual.sqlite).toBeNull()
    expect(artifact.residual.localStorage).not.toBeNull()
    expect(artifact.readiness.event).toBe('unavailable')
    expect(artifact.readiness.userData).toBe('unavailable')
    expect(artifact.p4Checks.unknownErrorCodes).toEqual([])
  })
})
