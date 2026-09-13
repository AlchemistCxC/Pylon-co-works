import { describe, expect, it } from 'vitest'
import { adaptAgentFailure, isKnownAgentFailureKind } from '../agentFailureState.ts'

// 迁移自 scripts/test-agent-failure-state.mts（P91 A1）：失败适配矩阵近平移。
const knownCases = [
  ['command-failure', 'error', 'command-failure', 'Agent 命令执行失败'],
  ['disconnected', 'disconnected', 'disconnected', 'Agent 已断开连接'],
  ['crashed', 'crashed', 'crashed', 'Agent 进程已崩溃'],
  ['error', 'error', 'error', 'Agent 发生错误'],
  ['reconnect-request-accepted', 'reconnecting', 'reconnect-request-accepted', '重连请求已接受，Agent 重连中'],
] as const

describe('adaptAgentFailure 已知失败矩阵', () => {
  it.each(knownCases)('%s', (kind, status, failureKind, diagnostic) => {
    const result = adaptAgentFailure({ kind })
    expect(result.status).toBe(status)
    expect(result.failureKind).toBe(failureKind)
    expect(result.diagnostic).toBe(diagnostic)

    const detailed = adaptAgentFailure({ kind, detail: 'detail' })
    expect(detailed.diagnostic).toBe(`${diagnostic}：detail`)
  })
})

describe('adaptAgentFailure 未知输入降级', () => {
  it.each([
    { kind: 'connected' },
    { kind: 'unknown' },
    { status: 'crashed' },
    null,
    undefined,
    'crashed',
    { kind: 'error', detail: 1 },
  ] as unknown as Array<Parameters<typeof adaptAgentFailure>[0]>)('%#', value => {
    const result = adaptAgentFailure(value)
    expect(result.status).toBe('error')
    expect(result.failureKind).toBe('unknown')
    expect(result.diagnostic).toBe('未知 Agent 失败状态')
  })
})

describe('isKnownAgentFailureKind', () => {
  it('识别已知 kind', () => {
    expect(isKnownAgentFailureKind('crashed')).toBe(true)
    expect(isKnownAgentFailureKind('connected')).toBe(false)
    expect(isKnownAgentFailureKind(undefined)).toBe(false)
  })
})
