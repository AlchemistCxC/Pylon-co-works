import { describe, expect, it } from 'vitest'
import {
  interactionRequestFromEnvelope,
  makeInteractionTransactionKey,
  normalizeInteractionEnvelope,
  normalizeInteractionRequest,
  transactionFromEnvelope,
} from '../interaction.ts'

describe('Interaction transaction key（P1-1）', () => {
  it('同请求（全 identity）生成确定 key，多 agent/多 session 不串', () => {
    const base = { agentId: 'peri-a', sessionId: 's1', requestId: '7', toolCallId: 'call-1', clientGeneration: 4 }
    expect(makeInteractionTransactionKey(base)).toBe(makeInteractionTransactionKey({ ...base }))
    expect(makeInteractionTransactionKey(base)).not.toBe(
      makeInteractionTransactionKey({ ...base, agentId: 'peri-b' }),
    )
    expect(makeInteractionTransactionKey(base)).not.toBe(
      makeInteractionTransactionKey({ ...base, sessionId: 's2' }),
    )
    expect(makeInteractionTransactionKey(base)).not.toBe(
      makeInteractionTransactionKey({ ...base, requestId: '8' }),
    )
  })

  it('toolCallId/generation 缺失时归一为 null 参与 key', () => {
    expect(makeInteractionTransactionKey({ agentId: 'a', sessionId: 's', requestId: '1', clientGeneration: null })).toBe(
      makeInteractionTransactionKey({ agentId: 'a', sessionId: 's', requestId: '1', toolCallId: undefined, clientGeneration: null }),
    )
  })

  it('transactionFromEnvelope 缺 identity 返回 null（不可提交）', () => {
    const full = { provider: 'peri', agentId: 'a', sessionId: 's', eventType: 'permission.request', requestId: '7', clientGeneration: 3, payload: {} }
    expect(transactionFromEnvelope(full)).toMatchObject({ agentId: 'a', sessionId: 's', requestId: '7', clientGeneration: 3 })
    expect(transactionFromEnvelope({ ...full, agentId: undefined })).toBeNull()
    expect(transactionFromEnvelope({ ...full, sessionId: undefined })).toBeNull()
    expect(transactionFromEnvelope({ ...full, requestId: undefined })).toBeNull()
  })
})

describe('InteractionRequest 规范化', () => {
  it('统一 envelope 保留 provider/agent/generation identity', () => {
    const envelope = normalizeInteractionEnvelope({
      provider: 'peri', agentId: 'peri-a', sessionId: 's1', eventType: 'permission.request',
      requestId: '7', toolCallId: 'call-1', clientGeneration: 4,
      payload: { description: '允许编辑', choices: ['allow_once', 'reject_once'] },
    })
    expect(envelope).not.toBeNull()
    expect(interactionRequestFromEnvelope(envelope!)).toMatchObject({
      kind: 'approval',
      identity: { provider: 'peri', agentId: 'peri-a', requestId: '7', sessionId: 's1', toolCallId: 'call-1', clientGeneration: 4 },
    })
  })


  it('兼容 Hermes clarify 单选与 request identity', () => {
    expect(normalizeInteractionRequest({
      eventType: 'clarify.request',
      payload: {
        request_id: 'clarify-1',
        session_id: 'session-a',
        question: '选择方案',
        choices: ['保留', '删除'],
      },
    })).toEqual({
      surface: 'interaction',
      kind: 'clarify',
      identity: { provider: null, agentId: null, requestId: 'clarify-1', sessionId: 'session-a', toolCallId: null, clientGeneration: null },
      questions: [{
        id: 'question-1', question: '选择方案', allowMultiple: false, allowFreeform: false,
        options: [{ id: '保留', label: '保留' }, { id: '删除', label: '删除' }],
      }],
      state: 'waiting',
      eventType: 'clarify.request',
    })
  })

  it('兼容 Peri AskUser 多问题、多选和 option description', () => {
    const result = normalizeInteractionRequest({
      eventType: 'ask-user',
      payload: {
        requestId: 'ask-1', sessionId: 'session-b',
        questions: [{
          id: 'q1', header: '范围', question: '选择文件', multi_select: true,
          options: [{ label: 'src', description: '源代码' }, { label: 'docs', description: '文档' }],
        }, { id: 'q2', question: '补充说明', options: [] }],
      },
    })
    expect(result).toMatchObject({ kind: 'ask-question', identity: { provider: null, agentId: null, requestId: 'ask-1', sessionId: 'session-b' } })
    expect(result?.questions).toHaveLength(2)
    expect(result?.questions[0]).toMatchObject({ allowMultiple: true })
    expect(result?.questions[0].options[0]).toMatchObject({ id: 'src', description: '源代码' })
    expect(result?.questions[1]).toMatchObject({ allowFreeform: true })
  })

  it('approval 使用 command/description 形成单问题，不伪造缺失 request id', () => {
    const result = normalizeInteractionRequest({
      eventType: 'approval.request',
      payload: { session_id: 'session-c', command: 'rm -rf tmp', description: '危险命令' },
    })
    expect(result).toMatchObject({ kind: 'approval', identity: { provider: null, agentId: null, requestId: null, sessionId: 'session-c' } })
    expect(result?.questions[0]).toMatchObject({ id: 'approval', question: '危险命令' })
  })

  it('approval 保留危险上下文供 renderer 消费，不读取 provider raw', () => {
    const result = normalizeInteractionRequest({
      eventType: 'approval.request',
      payload: {
        requestId: 'danger-1', reason: '需要修改构建产物', scope: 'workspace',
        command: 'rm -rf dist', path: '/workspace/dist',
      },
    })
    expect(result).toMatchObject({
      reason: '需要修改构建产物', scope: 'workspace', command: 'rm -rf dist', path: '/workspace/dist',
    })
  })

  it('approval 保留 capability、danger 和 expiry 的 normalized gate 字段', () => {
    const result = normalizeInteractionRequest({
      eventType: 'approval.request',
      payload: { requestId: 'danger-2', capability: 'fs.write', danger: true, expiry: '2026-08-23T09:00:00.000Z', prompt: '允许？' },
    })
    expect(result).toMatchObject({ capability: 'fs.write', danger: true, expiry: '2026-08-23T09:00:00.000Z' })
  })

  it('保留选项级 danger，供安全排序与焦点降级使用', () => {
    const result = normalizeInteractionRequest({
      eventType: 'approval.request',
      payload: { requestId: 'danger-option', prompt: '允许？', choices: [
        { id: 'deny', label: '拒绝', danger: true }, { id: 'allow', label: '允许' },
      ] },
    })
    expect(result?.questions[0]?.options).toEqual([
      { id: 'deny', label: '拒绝', danger: true }, { id: 'allow', label: '允许' },
    ])
  })

  it.each([
    'secret',
    'sudo',
  ])('规范化显式 %s interaction 名称为正式 C12 kind', kind => {
    expect(normalizeInteractionRequest({
      name: kind,
      payload: { requestId: `${kind}-1`, prompt: `输入 ${kind}` },
    })).toMatchObject({ kind, identity: { requestId: `${kind}-1` } })
  })

  it.each(['secret', 'sudo'])('保留显式 interaction payload kind=%s', kind => {
    expect(normalizeInteractionRequest({
      payload: { surface: 'interaction', kind, requestId: `${kind}-payload`, prompt: `输入 ${kind}` },
    })).toMatchObject({ kind, identity: { requestId: `${kind}-payload` } })
  })

  it('OAuth 只保留安全 URL 与 provider/state 摘要，拒绝危险 scheme', () => {
    const safe = normalizeInteractionRequest({
      name: 'oauth',
      metadata: { provider: 'peri' },
      payload: {
        requestId: 'oauth-1', title: '连接 GitHub',
        url: 'https://github.com/login/oauth/authorize?state=summary',
        stateSummary: '等待浏览器授权', expiry: '2026-08-23T09:05:00.000Z',
      },
    })
    expect(safe).toMatchObject({
      kind: 'oauth', url: 'https://github.com/login/oauth/authorize?state=summary',
      stateSummary: '等待浏览器授权', identity: { provider: 'peri' },
    })
    expect(normalizeInteractionRequest({
      name: 'oauth', payload: { requestId: 'oauth-bad', url: 'javascript:alert(1)' },
    })).toMatchObject({ kind: 'oauth', urlRedacted: true })
  })

  it('保留显式 unknown interaction，普通 tool 返回 null', () => {
    expect(normalizeInteractionRequest({ eventType: 'vendor.request', payload: { surface: 'interaction', requestId: 'x', prompt: '输入' } })).toMatchObject({ kind: 'unknown' })
    expect(normalizeInteractionRequest({ name: 'terminal', payload: { command: 'ls' } })).toBeNull()
  })

  it('清理空选项、重复 option id，保持稳定可渲染结构', () => {
    const result = normalizeInteractionRequest({
      name: 'clarify',
      payload: { requestId: 'x', question: '选择', choices: [{ id: 'same', label: 'A' }, { id: 'same', label: 'B' }, '', { label: 'C' }] },
    })
    expect(result?.questions[0].options.map(option => option.id)).toEqual(['same', 'same-2', 'C'])
  })
})
