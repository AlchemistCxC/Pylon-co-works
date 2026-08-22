import { describe, expect, it } from 'vitest'
import { createWorkbenchEnvelope } from '../events/workbenchEventSchema.ts'
import { projectWorkbench } from '../workbenchProjector.ts'

/**
 * C12 RED：interaction.oauth / interaction.secret / interaction.sudo 安全契约（DIC-C12-01）。
 *
 * - token/secret/sudo credential 永不进入 journal/document/diagnostic；
 * - 只保留 omission metadata（redacted 标记 + correlation）；
 * - oauth URL 经 scheme 白名单校验，bad scheme 进 unknown。
 */

const envelope = (sequence: number, event: Parameters<typeof createWorkbenchEnvelope>[0]['event']) =>
  createWorkbenchEnvelope({
    sessionId: 'session-c12',
    sequence,
    recordedAt: `2026-08-23T09:00:0${sequence}.000Z`,
    source: { provider: 'claude', sourceId: `c12-${sequence}` },
    identity: {},
    provenance: { origin: 'local-observed', trust: 'authoritative' },
    event,
  })

describe('C12 secret-bearing interaction projection', () => {
  it('keeps an OAuth request structured but strips any credential fields from the document', () => {
    const { document } = projectWorkbench([
      envelope(1, {
        type: 'interaction.requested', interactionId: 'oauth-1',
        request: {
          kind: 'oauth',
          provider: 'github',
          url: 'https://github.com/login/oauth/authorize?state=abc',
          expiry: '2026-08-23T09:05:00.000Z',
          // wire 异常携带的敏感字段：投影必须剥离，不得进入 document
          accessToken: 'gho_SHOULD_NOT_PERSIST',
          clientSecret: 'SHOULD_NOT_PERSIST',
        },
      }),
    ])
    const raw = JSON.stringify(document)
    expect(raw).not.toContain('gho_SHOULD_NOT_PERSIST')
    expect(raw).not.toContain('SHOULD_NOT_PERSIST')
    const interaction = document.interactions[0]
    expect(interaction.status).toBe('requested')
    expect((interaction.request as { provider?: string }).provider).toBe('github')
    expect((interaction.request as { url?: string }).url).toContain('authorize')
  })

  it('replaces a secret prompt value with an omission marker while keeping correlation', () => {
    const { document } = projectWorkbench([
      envelope(1, {
        type: 'interaction.requested', interactionId: 'sec-1',
        request: {
          kind: 'secret',
          prompt: 'API token',
          // wire 泄漏场景：value 绝不能落盘
          value: 'sk-SUPER-SECRET',
          correlationId: 'corr-42',
        },
      }),
    ])
    const raw = JSON.stringify(document)
    expect(raw).not.toContain('sk-SUPER-SECRET')
    const request = document.interactions[0].request as Record<string, unknown>
    // omission metadata 替代原值
    expect(request.valueRedacted).toBe(true)
    expect(request.correlationId).toBe('corr-42')
  })

  it('keeps sudo command context visible without persisting the password', () => {
    const { document } = projectWorkbench([
      envelope(1, {
        type: 'interaction.requested', interactionId: 'sudo-1',
        request: {
          kind: 'sudo',
          command: 'apt install build-essential',
          reason: 'build dependencies',
          timeoutMs: 30000,
          password: 'linux-password-plain',
        },
      }),
      envelope(2, {
        type: 'interaction.resolved', interactionId: 'sudo-1',
        response: { approved: true, password: 'linux-password-plain' },
      }),
    ])
    const raw = JSON.stringify(document)
    expect(raw).not.toContain('linux-password-plain')
    const interaction = document.interactions[0]
    expect((interaction.request as { command?: string }).command).toBe('apt install build-essential')
    // response 只保留决策事实，密码字段被剥除
    expect((interaction.response as { approved?: boolean }).approved).toBe(true)
    expect((interaction.response as Record<string, unknown>).password).toBeUndefined()
  })
})
