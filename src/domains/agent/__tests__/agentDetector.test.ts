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

  /**
   * 前提变更（§3.3 例外 1）：检测报告新增 `providers`/`preflight` 两个字段，
   * 旧断言未含它们。断言改为显式要求两者存在且为空数组（严格程度不降：
   * 从“四个字段相等”变为“六个字段相等”）。
   */
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
      providers: [],
      preflight: [],
      diagnostics: [{ code: 'version_probe_timeout', stage: 'version_probe', detectorId: 'fixture', message: 'timeout', retryable: true }],
      elapsedMs: 101,
      truncated: false,
    })
    expect(normalizeAgentDetectionReport({ candidates: 'corrupt', diagnostics: [null], elapsedMs: -1, truncated: 'yes' })).toEqual({
      candidates: [], providers: [], preflight: [], diagnostics: [], elapsedMs: 0, truncated: false,
    })
  })

  /** A4：双证据与安装状态必须严格归一化，不可解释的输入一律丢弃。 */
  it('normalizes per-provider evidence and preflight, dropping unexplainable states', () => {
    const report = normalizeAgentDetectionReport({
      candidates: [],
      diagnostics: [],
      elapsedMs: 2,
      truncated: false,
      providers: [
        {
          provider: 'claude-code', detectorId: 'builtin.detector.claude-code', adapterRelationDeclared: true,
          acpCommands: [{ kind: 'acp-command', path: 'C:/x/ccb.cmd', source: 'path' }, { path: 'no-kind' }],
          nativeCommands: [],
          sharedConfigPresent: true,
        },
        { provider: '', detectorId: 'x', adapterRelationDeclared: false, acpCommands: [], nativeCommands: [], sharedConfigPresent: false },
        { provider: 'missing-flag', detectorId: 'x', acpCommands: [], nativeCommands: [] },
        // 子数组形状错误 → 整行丢弃：形状不可信的行不能拿去解释安装状态。
        { provider: 'corrupt-commands', detectorId: 'x', adapterRelationDeclared: true, acpCommands: 'corrupt', nativeCommands: [], sharedConfigPresent: false },
      ],
      preflight: [
        {
          provider: 'claude-code', status: 'nativeMissing', passed: false,
          adapter: { nativeCmd: 'claude', nativeLabel: 'Claude Code CLI', nativePresent: false, acpPresent: true, sharedConfigDir: '~/.claude', sharedConfigPresent: true },
          checks: [{ checkId: 'version-gate:steering-prompt-required', label: 'adapter version', status: 'PASS', message: 'm', fixes: [] }, { checkId: 'bad', status: 'NOPE' }],
        },
        { provider: 'future', status: 'somethingNew', passed: false, checks: [] },
        { provider: 'no-passed', status: 'installed', checks: [] },
      ],
    })
    // 只有一条 provider 证据合法（空 provider / 缺 flag / 子数组形状错误的都丢弃），
    // 且非法 hit 被逐条过滤。
    expect(report.providers).toEqual([{
      provider: 'claude-code', detectorId: 'builtin.detector.claude-code', adapterRelationDeclared: true,
      acpCommands: [{ kind: 'acp-command', path: 'C:/x/ccb.cmd', source: 'path' }],
      nativeCommands: [],
      sharedConfigPresent: true,
    }])
    // 未知状态与缺 passed 的条目被丢弃；非法 check 也被丢弃。
    expect(report.preflight).toHaveLength(1)
    expect(report.preflight[0]).toMatchObject({ provider: 'claude-code', status: 'nativeMissing', passed: false })
    expect(report.preflight[0].checks).toHaveLength(1)
    expect(report.preflight[0].adapter?.nativeCmd).toBe('claude')
  })
})
