import { describe, expect, it } from 'vitest'
import {
  candidateImportMode,
  candidateValidationDetails,
  normalizeAgentCandidateValidationResult,
  type AgentCandidateValidationState,
} from '../candidateValidation.ts'
import type { AgentRuntimeCandidate } from '../agentDetector.ts'

function candidate(identityConfidence: AgentRuntimeCandidate['identityConfidence']): AgentRuntimeCandidate {
  return {
    candidateId: `candidate-${identityConfidence}`,
    detectorId: 'builtin.detector.test',
    provider: 'test',
    suggestedAgentId: 'test',
    name: 'Test Agent',
    executable: 'test-agent',
    args: [],
    evidence: [],
    identityConfidence,
    protocolAvailability: 'not_tested',
    warnings: [],
  }
}

const failed: AgentCandidateValidationState = {
  status: 'failed',
  result: {
    ok: false,
    agentId: 'test',
    durationMs: 321,
    error: {
      code: 'agent_initialize_failed',
      message: 'ACP connection closed',
      action: 'open-runtime-log',
      stage: 'initialize',
      exitCode: 7,
      stderr: 'missing provider',
    },
  },
}

describe('Agent 候选导入门禁', () => {
  it('exact/high 验证失败后允许未验证导入，但未验证前仍不可导入', () => {
    expect(candidateImportMode(candidate('exact'), failed)).toBe('unverified')
    expect(candidateImportMode(candidate('high'), failed)).toBe('unverified')
    expect(candidateImportMode(candidate('high'), undefined)).toBe('blocked')
    expect(candidateImportMode(candidate('high'), { status: 'testing' })).toBe('blocked')
  })

  it('medium/low 验证失败时继续阻止导入，所有置信度验证成功后均可导入', () => {
    expect(candidateImportMode(candidate('medium'), failed)).toBe('blocked')
    expect(candidateImportMode(candidate('low'), failed)).toBe('blocked')
    for (const confidence of ['exact', 'high', 'medium', 'low'] as const) {
      expect(candidateImportMode(candidate(confidence), {
        status: 'ok',
        result: { ok: true, agentId: 'test', durationMs: 25, error: null },
      })).toBe('verified')
    }
  })

  it('只认可本地验证状态，候选 DTO 不能把 ACP 可用性伪装成已验证', () => {
    const backendClaim: AgentRuntimeCandidate = { ...candidate('high'), protocolAvailability: 'verified' }
    expect(candidateImportMode(backendClaim, undefined)).toBe('blocked')
  })

  it('把阶段、退出码、stderr 与耗时转换为可见诊断，不伪造缺失字段', () => {
    expect(candidateValidationDetails(failed)).toEqual({
      headline: 'ACP 验证失败',
      duration: '321ms',
      stage: '初始化握手',
      exitCode: '7',
      stderr: 'missing provider',
      message: 'ACP connection closed',
    })
    expect(candidateValidationDetails({
      status: 'failed',
      result: { ok: false, agentId: 'test', durationMs: 15_000, error: { code: 'agent_connection_timeout', message: 'timeout', action: 'open-runtime-log', stage: 'timeout', exitCode: null, stderr: null } },
    })).toMatchObject({ duration: '15.0s', stage: '总超时', exitCode: '未提供', stderr: '未捕获到 stderr' })
  })

  it('保留能力协商阶段与可重试/远端摘要字段', () => {
    const result = normalizeAgentCandidateValidationResult({
      ok: false,
      agentId: 'fixture',
      durationMs: 42.8,
      error: {
        code: 'agent_capability_invalid',
        message: 'capability shape invalid',
        action: 'open-runtime-log',
        stage: 'capability',
        retryable: false,
        ioKind: null,
        remoteCode: -32001,
        remoteDataSummary: 'object(1 keys)',
      },
    }, 'fallback')
    expect(result).toMatchObject({
      durationMs: 42,
      error: {
        stage: 'capability',
        retryable: false,
        remoteCode: -32001,
        remoteDataSummary: 'object(1 keys)',
      },
    })
    expect(candidateValidationDetails({ status: 'failed', result })).toMatchObject({ stage: '能力协商' })
  })
})
