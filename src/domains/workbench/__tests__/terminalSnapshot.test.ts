import { describe, expect, it } from 'vitest'
import { normalizeContentBlock } from '../normalizers/normalizerSupport.ts'
import { terminalSnapshotFromPart } from '../terminalSnapshot.ts'

/**
 * C07 RED：执行/终端/日志契约（DIC-C07-01 + 架构层消费补全）。
 *
 * 卡面要求：
 * - normalizer 区分 command/input、stdout、stderr、structured log、exit/termination；
 *   保留 stream ordinal 和 timestamp confidence；
 * - terminal/log snapshot 必须区分 stdout/stderr、exitCode、status、session/process
 *   identity、truncation（captured/omitted）与 error；不得把多路输出压成单一 message；
 * - killed、timeout、non-zero exit 分开；终态后迟到 chunk 按协议策略保留并诊断；
 * - secret-like environment 不显示 raw。
 */

describe('C07 normalizer terminal/log classification', () => {
  it('normalizes terminal block with separated stdout/stderr streams and exit', () => {
    const { part } = normalizeContentBlock({
      type: 'terminal',
      command: 'npm test',
      streams: [
        { stream: 'stdout', text: 'running tests...', ordinal: 0 },
        { stream: 'stderr', text: 'warning: deprecated flag', ordinal: 1 },
        { stream: 'stdout', text: '3 passed', ordinal: 2 },
      ],
      exitCode: 0,
      status: 'completed',
      durationMs: 4200,
    })
    expect(part.kind).toBe('terminal')
    const term = part as unknown as {
      command?: string
      streams?: readonly { stream: string; text: string; ordinal?: number }[]
      exitCode?: number
      status?: string
      durationMs?: number
    }
    expect(term.command).toBe('npm test')
    // 多路输出保持分条——不压成单一字符串
    expect(term.streams).toHaveLength(3)
    expect(term.streams?.[1]?.stream).toBe('stderr')
    expect(term.streams?.[2]?.ordinal).toBe(2)
    expect(term.exitCode).toBe(0)
    expect(term.status).toBe('completed')
    expect(term.durationMs).toBe(4200)
  })

  it('drops malformed or unknown terminal chunks with a diagnostic', () => {
    const { part, diagnostic } = normalizeContentBlock({
      type: 'terminal',
      command: 'task',
      streams: [
        { stream: 'stdout', text: 'kept', ordinal: 0 },
        { stream: 'stdin', text: 'must not render', ordinal: 1 },
        { stream: 'stderr', text: 42, ordinal: 2 },
      ],
    })
    expect(part.kind).toBe('terminal')
    expect((part as { streams: readonly unknown[] }).streams).toEqual([
      { stream: 'stdout', text: 'kept', ordinal: 0 },
    ])
    expect(diagnostic?.code).toBe('content.terminal.entries-dropped')
    expect(diagnostic?.path).toEqual(['streams'])
  })

  it('records termination reason for killed/timeout separately from non-zero exit', () => {
    for (const [reason, expected] of [['timeout', 'timeout'], ['killed', 'killed'], ['exit', 'non-zero-exit']] as const) {
      const { part } = normalizeContentBlock({
        type: 'terminal',
        command: 'long-job',
        streams: [{ stream: 'stdout', text: 'partial' }],
        status: 'failed',
        ...(reason === 'exit' ? { exitCode: 137, terminatedBy: undefined } : { terminatedBy: expected }),
      })
      const term = part as unknown as { terminatedBy?: string; exitCode?: number }
      if (reason === 'exit') {
        expect(term.exitCode).toBe(137)
      } else {
        expect(term.terminatedBy).toBe(expected)
      }
    }
  })

  it('terminal without command or streams falls back to unknown with diagnostic', () => {
    const { part, diagnostic } = normalizeContentBlock({ type: 'terminal' })
    expect(part.kind).toBe('unknown')
    expect(diagnostic?.code).toBe('content.terminal.invalid')
  })

  it('redacts secret-like environment variables from terminal input', () => {
    const { part } = normalizeContentBlock({
      type: 'terminal',
      command: 'API_KEY=sk-abc123 npm deploy',
      env: { API_KEY: 'sk-abc123', NODE_ENV: 'production' },
      streams: [{ stream: 'stdout', text: 'deployed' }],
    })
    const term = part as unknown as { env?: Record<string, string>; command?: string }
    // env 值脱敏：secret-like 键不保留原值
    if (term.env) {
      expect(term.env.API_KEY).not.toBe('sk-abc123')
      expect(term.env.NODE_ENV).toBe('production')
    }
    // command 原样保留（用户自己的输入，journal 权威），env 表才负责脱敏
    expect(part.kind).toBe('terminal')
  })

  it('normalizes terminal identity, truncation accounting, and error', () => {
    const { part } = normalizeContentBlock({
      type: 'terminal',
      process_id: 'proc-1',
      session_id: 'shell-1',
      streams: [{ stream: 'stderr', text: 'failed' }],
      truncation: { capturedLines: 1, omittedLines: 99, capturedBytes: 6, omittedBytes: 800 },
      error: { message: 'command failed', code: 'EFAIL' },
      status: 'failed',
    })
    expect(terminalSnapshotFromPart(part)).toMatchObject({
      processId: 'proc-1',
      sessionId: 'shell-1',
      truncation: { capturedLines: 1, omittedLines: 99, capturedBytes: 6, omittedBytes: 800 },
      error: { message: 'command failed', code: 'EFAIL' },
    })
  })

  it('normalizes structured log entries with level/timestamp confidence', () => {
    const { part } = normalizeContentBlock({
      type: 'log',
      source: 'build-worker',
      entries: [
        { level: 'info', text: 'compiling', timestampConfidence: 'observed' },
        { level: 'warn', text: 'slow transform', timestampConfidence: 'synthetic' },
      ],
    })
    expect(part.kind).toBe('log')
    const log = part as unknown as {
      source?: string
      entries?: readonly { level: string; text: string; timestampConfidence?: string }[]
    }
    expect(log.source).toBe('build-worker')
    expect(log.entries?.[1]?.timestampConfidence).toBe('synthetic')
  })

  it('normalizes unknown log levels and drops malformed entries with a diagnostic', () => {
    const { part, diagnostic } = normalizeContentBlock({
      type: 'log',
      entries: [
        { level: 'verbose', text: 'kept as unknown', ordinal: 0 },
        { level: 'info', text: 42, ordinal: 1 },
        { level: 'warn', text: 'bad confidence', timestampConfidence: 'guessed' },
      ],
    })
    expect(part.kind).toBe('log')
    expect((part as { entries: readonly unknown[] }).entries).toEqual([
      { level: 'unknown', originalLevel: 'verbose', text: 'kept as unknown', ordinal: 0 },
    ])
    expect(diagnostic?.code).toBe('content.log.entries-dropped')
  })
})

describe('C07 terminalSnapshotFromPart (stream accounting)', () => {
  it('separates stdout/stderr lines with ordinals preserved', () => {
    const snapshot = terminalSnapshotFromPart({
      kind: 'terminal',
      command: 'npm test',
      streams: [
        { stream: 'stdout', text: 'one', ordinal: 0 },
        { stream: 'stderr', text: 'err!', ordinal: 1 },
        { stream: 'stdout', text: 'two', ordinal: 2 },
      ],
      exitCode: 0,
      status: 'completed',
    })
    expect(snapshot).not.toBeNull()
    if (!snapshot) return
    expect(snapshot.stdoutLines).toEqual(['one', 'two'])
    expect(snapshot.stderrLines).toEqual(['err!'])
    expect(snapshot.stdout.map(entry => entry.ordinal)).toEqual([0, 2])
    expect(snapshot.stderr.map(entry => entry.ordinal)).toEqual([1])
    expect(snapshot.exitCode).toBe(0)
    expect(snapshot.command).toBe('npm test')
  })

  it('accounts truncation: captured vs omitted bytes/lines stay explicit', () => {
    const snapshot = terminalSnapshotFromPart({
      kind: 'terminal',
      command: 'noisy',
      streams: [{ stream: 'stdout', text: 'kept line' }],
      truncation: { capturedLines: 1, omittedLines: 9999, omittedBytes: 1234567 },
      status: 'completed',
    })
    expect(snapshot?.truncation).toEqual({ capturedLines: 1, omittedLines: 9999, omittedBytes: 1234567 })
  })

  it('keeps process/session identity and normalized error in the terminal snapshot', () => {
    const snapshot = terminalSnapshotFromPart({
      kind: 'terminal',
      processId: 'proc-42',
      sessionId: 'shell-7',
      streams: [{ stream: 'stderr', text: 'permission denied', ordinal: 0 }],
      status: 'failed',
      error: { message: 'command failed', code: 'EACCES' },
    })
    expect(snapshot).toMatchObject({
      processId: 'proc-42', sessionId: 'shell-7', status: 'failed',
      error: { message: 'command failed', code: 'EACCES' },
    })
  })

  it('flags late chunks after terminal state per protocol policy with diagnostic metadata', () => {
    const snapshot = terminalSnapshotFromPart({
      kind: 'terminal',
      command: 'done',
      streams: [{ stream: 'stdout', text: 'late arrival', ordinal: 9, lateAfterTerminal: true }],
      status: 'completed',
    })
    expect(snapshot?.lateChunks).toHaveLength(1)
    expect(snapshot?.lateChunks?.[0]?.text).toBe('late arrival')
    // 迟到 chunk 保留（协议策略）但被标记，不混入正常流计数
    expect(snapshot?.stdoutLines).toEqual([])
  })

  it('returns null for non-terminal parts', () => {
    expect(terminalSnapshotFromPart({ kind: 'log', entries: [] })).toBeNull()
  })
})
