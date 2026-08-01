import { strict as assert } from 'node:assert'
import { adaptAgentFailure, isKnownAgentFailureKind } from '../src/components/settings/agentFailureState.ts'

const cases = [
  ['command-failure', 'error', 'command-failure', 'Agent 命令执行失败'],
  ['disconnected', 'disconnected', 'disconnected', 'Agent 已断开连接'],
  ['crashed', 'crashed', 'crashed', 'Agent 进程已崩溃'],
  ['error', 'error', 'error', 'Agent 发生错误'],
  ['reconnect-request-accepted', 'reconnecting', 'reconnect-request-accepted', '重连请求已接受，Agent 重连中'],
] as const

for (const [kind, status, failureKind, diagnostic] of cases) {
  const result = adaptAgentFailure({ kind })
  assert.equal(result.status, status)
  assert.equal(result.failureKind, failureKind)
  assert.equal(result.diagnostic, diagnostic)

  const detailed = adaptAgentFailure({ kind, detail: 'detail' })
  assert.equal(detailed.diagnostic, `${diagnostic}：detail`)
}

for (const value of [
  { kind: 'connected' },
  { kind: 'unknown' },
  { status: 'crashed' },
  null,
  undefined,
  'crashed',
  { kind: 'error', detail: 1 },
]) {
  const result = adaptAgentFailure(value)
  assert.equal(result.status, 'error')
  assert.equal(result.failureKind, 'unknown')
  assert.equal(result.diagnostic, '未知 Agent 失败状态')
}

assert.equal(isKnownAgentFailureKind('crashed'), true)
assert.equal(isKnownAgentFailureKind('connected'), false)
assert.equal(isKnownAgentFailureKind(undefined), false)

console.log('agent failure state 回归矩阵通过')
