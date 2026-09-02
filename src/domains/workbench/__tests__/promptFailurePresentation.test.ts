import { describe, expect, it } from 'vitest'
import { presentPromptFailure } from '../promptFailurePresentation.ts'

describe('prompt failure presentation', () => {
  it('does not expose a provider-configured 180s value as the user-facing elapsed time', () => {
    const result = presentPromptFailure('ACP protocol: timed out after 180s (provider error)', {
      source: 'provider',
      configuredTimeoutSecs: 180,
      actualElapsedMs: 24_000,
      providerMessage: 'ACP protocol: timed out after 180s (provider error)',
    })

    expect(result.userSummary).toBe('Provider 返回错误')
    expect(result.userSummary).not.toContain('180s')
    expect(result.technicalMessage).toContain('180s')
  })

  it('uses the actual local timeout bound and keeps the raw error technical', () => {
    const result = presentPromptFailure('timed out after 180s', {
      source: 'prompt-timeout',
      timeoutKind: 'first-token',
      configuredTimeoutSecs: 180,
      triggeredTimeoutSecs: 2,
      actualElapsedMs: 2_041,
    })

    expect(result.userSummary).toBe('首个响应超时（2s）')
    expect(result.userSummary).not.toContain('180s')
    expect(result.technicalMessage).toBe('timed out after 180s')
  })

  it('keeps untyped legacy errors unchanged', () => {
    expect(presentPromptFailure('network unavailable')).toEqual({ userSummary: 'network unavailable' })
  })

  it('does not fall back to the configured budget when a triggered bound is invalid', () => {
    const result = presentPromptFailure('timed out after 180s', {
      source: 'prompt-timeout', timeoutKind: 'idle',
      configuredTimeoutSecs: 180, triggeredTimeoutSecs: 0,
    })
    expect(result.userSummary).toBe('响应闲置超时')
    expect(result.userSummary).not.toContain('180s')
  })
})
