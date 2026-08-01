import { strict as assert } from 'node:assert'
import { normalizeAgentStatus } from '../src/components/settings/agentTypes.ts'

const fallbackAgent = 'peri'

const missingStatus = normalizeAgentStatus({ agent: 'missing-status' }, fallbackAgent)
assert.equal(missingStatus.agent, 'missing-status')
assert.equal(missingStatus.status, 'connected')
assert.equal(missingStatus.recentError, undefined)

const legacyCrashed = normalizeAgentStatus({ agent: 'legacy-crashed', crashed: true }, fallbackAgent)
assert.equal(legacyCrashed.agent, 'legacy-crashed')
assert.equal(legacyCrashed.status, 'crashed')
assert.equal(legacyCrashed.recentError, undefined)

const unknownExplicitStatus = normalizeAgentStatus({ agent: 'unknown-status', status: 'paused' }, fallbackAgent)
assert.equal(unknownExplicitStatus.agent, 'unknown-status')
assert.equal(unknownExplicitStatus.status, 'error')
assert.notEqual(unknownExplicitStatus.status, 'connected')
assert.equal(unknownExplicitStatus.recentError, '未知 Agent 状态：paused')

const unknownStatusWithDiagnostic = normalizeAgentStatus({
  agent: 'unknown-with-error',
  status: 'future-status',
  error: '上游返回了未识别状态',
}, fallbackAgent)
assert.equal(unknownStatusWithDiagnostic.status, 'error')
assert.notEqual(unknownStatusWithDiagnostic.status, 'connected')
assert.equal(unknownStatusWithDiagnostic.recentError, '上游返回了未识别状态')

const fallbackAgentStatus = normalizeAgentStatus({ status: 'mystery' }, fallbackAgent)
assert.equal(fallbackAgentStatus.agent, fallbackAgent)
assert.equal(fallbackAgentStatus.status, 'error')
assert.match(fallbackAgentStatus.recentError || '', /未知 Agent 状态：mystery/)

console.log('agent unknown status 安全处理专项回归通过')
