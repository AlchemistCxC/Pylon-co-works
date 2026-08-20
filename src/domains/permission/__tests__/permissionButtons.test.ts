/**
 * permissionButtons — 按钮映射的纯域单测（P0-03 / CR-002 折入）。
 *
 * D15：不硬编码 Peri/Hermes 按钮集——保持 wire 顺序、optionId 原值，
 * label 缺省回退 name → optionId（§5.5 契约字段 name；标签别名 label 优先）。
 */

import { describe, expect, it } from 'vitest'
import { resolvePermissionButtons } from '../permissionButtons.ts'
import type { PermissionRequest } from '../permissionTypes.ts'

function request(options: PermissionRequest['options']): PermissionRequest {
  return {
    requestId: 'perm-1',
    provider: 'hermes',
    agentId: 'hermes-a',
    sessionId: 's1',
    clientGeneration: 1,
    options,
  }
}

describe('resolvePermissionButtons 保持 wire 语义（D15 / ACP-02 §5.5）', () => {
  it('保持 wire 顺序与 optionId 原值（不排序/不正规化/不硬编码按钮集）', () => {
    const buttons = resolvePermissionButtons(
      request([{ optionId: 'deny' }, { optionId: 'allow_once' }, { optionId: 'always_allow' }]),
    )
    expect(buttons.map(button => button.optionId)).toEqual(['deny', 'allow_once', 'always_allow'])
  })

  it('label 缺省回退 name（§5.5 契约字段），再回退 optionId（CR-002）', () => {
    const buttons = resolvePermissionButtons(
      request([
        { optionId: 'a', name: '允许' },
        { optionId: 'b' },
        { optionId: 'c', label: '标签优先', name: 'name 不应被用' },
      ]),
    )
    expect(buttons[0].label).toBe('允许')
    expect(buttons[1].label).toBe('b')
    expect(buttons[2].label).toBe('标签优先')
  })

  it('kind 透传（Hermes kind=reject_once 是拒绝类别，只参与选择不参与应答）', () => {
    const buttons = resolvePermissionButtons(
      request([
        { optionId: 'allow_once', kind: 'allowOnce' },
        { optionId: 'reject_once', kind: 'rejectOnce' },
      ]),
    )
    expect(buttons[0].kind).toBe('allowOnce')
    expect(buttons[1].kind).toBe('rejectOnce')
  })

  it('空/非字符串 label 与 name 一律回退 optionId（宽容读取，不做解释）', () => {
    const buttons = resolvePermissionButtons(
      request([{ optionId: 'x', label: '', name: '' }, { optionId: 'y', label: 42 as unknown as string }]),
    )
    expect(buttons[0].label).toBe('x')
    expect(buttons[1].label).toBe('y')
  })
})
