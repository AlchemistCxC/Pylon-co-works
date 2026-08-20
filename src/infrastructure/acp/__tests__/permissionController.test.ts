import { describe, expect, it } from 'vitest'
import { normalizePermissionRequest, resolveTimeoutDenyOption } from '../permissionController.ts'

/**
 * ACP-01 前端聚焦测试：requestId 原值保留（wire 字符串回显，不 Number() 收窄）。
 *
 * 回归锚点：旧实现 `Number(envelope.requestId)` + `isFinite` 会把 string id
 * （"perm-1"）得 NaN → 整单丢弃。新实现保留原样——string-id agent（Hermes 等）
 * 的权限请求不再被前端静默丢弃。
 */

function eventWith(requestId: unknown): unknown {
  return {
    provider: 'peri',
    agentId: 'peri-a',
    sessionId: 's1',
    eventType: 'permission.request',
    requestId,
    clientGeneration: 3,
    payload: {
      options: [{ optionId: 'allow_once' }, { optionId: 'reject_once' }],
      title: '执行 Bash',
    },
  }
}

describe('normalizePermissionRequest（ACP-01 requestId 类型化）', () => {
  it('string id "perm-1" 原样保留（旧实现 Number→NaN 整单丢弃）', () => {
    const request = normalizePermissionRequest(eventWith('perm-1'))
    expect(request).not.toBeNull()
    expect(request?.requestId).toBe('perm-1')
  })

  it('numeric 回显 "7" 保留字符串形态（不转回 number）', () => {
    const request = normalizePermissionRequest(eventWith('7'))
    expect(request?.requestId).toBe('7')
    expect(typeof request?.requestId).toBe('string')
  })

  it('缺 requestId 仍返回 null（不可提交，不臆造 0）', () => {
    expect(normalizePermissionRequest(eventWith(undefined))).toBeNull()
    expect(normalizePermissionRequest(eventWith(null))).toBeNull()
  })

  it('timeout deny 优先 reject_once，其次 deny/reject 语义（ACP-02 kind 兼容）', () => {
    expect(
      resolveTimeoutDenyOption([{ optionId: 'allow_once' }, { optionId: 'reject_once' }])?.optionId,
    ).toBe('reject_once')
    // kind=reject_once 语义类别（Hermes：optionId=deny + kind=reject_once）
    expect(
      resolveTimeoutDenyOption([
        { optionId: 'allow_once' },
        { optionId: 'deny', kind: 'reject_once' },
      ])?.optionId,
    ).toBe('deny')
    // 无任何拒绝语义 → null（不伪造 optionId）
    expect(resolveTimeoutDenyOption([{ optionId: 'allow_once' }])).toBeNull()
  })

  it('camelCase kind/optionId（rejectOnce）与 snake_case 语义同义（ACP-04 CR-001）', () => {
    // Hermes：optionId=deny + kind=rejectOnce（camelCase）——必须优先 reject_once 语义项
    expect(
      resolveTimeoutDenyOption([
        { optionId: 'deny' },
        { optionId: 'allow_once', kind: 'rejectOnce' },
      ])?.optionId,
    ).toBe('allow_once')
    // optionId 本身为 camelCase rejectOnce
    expect(
      resolveTimeoutDenyOption([{ optionId: 'rejectOnce' }, { optionId: 'allow_once' }])?.optionId,
    ).toBe('rejectOnce')
    // 较早 deny 项存在时仍选 reject_once 语义项（与后端 pick_option 优先级一致）
    expect(
      resolveTimeoutDenyOption([
        { optionId: 'deny' },
        { optionId: 'allow_always', kind: 'rejectOnce' },
      ])?.optionId,
    ).toBe('allow_always')
  })
})
