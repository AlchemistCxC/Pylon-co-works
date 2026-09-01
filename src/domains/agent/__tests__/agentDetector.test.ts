import { describe, expect, it } from 'vitest'
import { BUILTIN_AGENT_DETECTORS, normalizeAgentDetectionReport, normalizeAgentRuntimeCandidates, selectAcpRuntimeDetectorIds } from '../agentDetector.ts'

describe('agent detector DTO', () => {
  it('keeps explainable candidates and filters corrupt values', () => {
    const candidates = normalizeAgentRuntimeCandidates([null, { candidateId: 'peri:c', detectorId: 'builtin.detector.peri', provider: 'peri', suggestedAgentId: 'peri', name: 'Peri', executable: 'C:/peri.exe', args: [], evidence: [{ kind: 'path', detail: 'C:/peri.exe' }], identityConfidence: 'high', protocolAvailability: 'not_tested', warnings: [], alreadyImportedAgentId: 'peri' }])
    expect(candidates).toHaveLength(1)
    expect(candidates[0].alreadyImportedAgentId).toBe('peri')
    expect(candidates[0].startability).toBe('not_tested')
  })

  it('publishes only verified native ACP detector families', () => {
    expect(BUILTIN_AGENT_DETECTORS).toEqual([
      { id: 'builtin.detector.peri', provider: 'peri', protocol: 'acp', priority: 100 },
      { id: 'builtin.detector.hermes', provider: 'hermes', protocol: 'acp', priority: 100 },
      { id: 'builtin.detector.claude-code', provider: 'claude-code', protocol: 'acp', priority: 100 },
    ])
    expect(BUILTIN_AGENT_DETECTORS.some(detector => detector.provider === 'pi')).toBe(false)
  })

  it('rejects candidates without a complete executable invocation', () => {
    expect(normalizeAgentRuntimeCandidates([{ candidateId: 'broken', detectorId: 'x', provider: 'x', executable: 'x', evidence: [], warnings: [], identityConfidence: 'high', protocolAvailability: 'not_tested' }])).toEqual([])
  })

  it('passes only ordered ACP contributions to native discovery', () => {
    expect(selectAcpRuntimeDetectorIds([
      { id: 'later', provider: 'future', protocol: 'acp', priority: 10 },
      { id: 'first', provider: 'future', protocol: 'acp', priority: 20 },
      { id: '', provider: 'broken', protocol: 'acp', priority: 100 },
    ])).toEqual(['first', 'later'])
  })

  it('normalizes candidates and diagnostics as one report without conflating identity and ACP state', () => {
    expect(normalizeAgentDetectionReport({
      candidates: [{
        candidateId: 'fixture:one', detectorId: 'fixture', provider: 'fixture', suggestedAgentId: 'fixture',
        name: 'Fixture', executable: 'fixture.exe', args: ['acp'], evidence: [], warnings: [],
        identityConfidence: 'high', protocolAvailability: 'not_tested',
      }],
      diagnostics: [{ code: 'version_probe_timeout', stage: 'version_probe', detectorId: 'fixture', message: 'timeout', retryable: true }],
      elapsedMs: 101,
      truncated: false,
    })).toEqual({
      candidates: [expect.objectContaining({ identityConfidence: 'high', startability: 'not_tested', protocolAvailability: 'not_tested' })],
      diagnostics: [{ code: 'version_probe_timeout', stage: 'version_probe', detectorId: 'fixture', message: 'timeout', retryable: true }],
      elapsedMs: 101,
      truncated: false,
    })
    expect(normalizeAgentDetectionReport({ candidates: 'corrupt', diagnostics: [null], elapsedMs: -1, truncated: 'yes' })).toEqual({
      candidates: [], diagnostics: [], elapsedMs: 0, truncated: false,
    })
  })
})
