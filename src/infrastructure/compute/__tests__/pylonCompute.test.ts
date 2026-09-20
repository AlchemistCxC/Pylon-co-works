// issue #220 WP1 的 parity witness：WASM 计算核的 canonical 出口必须与 TS 侧逐项一致。
//
// 这不是「新写的测试通过就好」——两侧本来就是同一份契约的两处手抄（Rust
// `pylon-canonical-types` vs TS `domains/events/{eventSchema,canonicalNormalizer}.ts`），
// 所以断言取的是**等价性**：词表逐项相等、判别符映射对同一输入给出同一输出、
// identity 推导逐字节相等。任何一侧单独漂移，这里就红。

import { describe, expect, it } from 'vitest'

import {
  CANONICAL_EVENT_TYPES,
  nextEventSequence,
  toCanonicalEventId,
  toCanonicalOwnerKey,
} from '../../../domains/events/eventSchema'
import { canonicalEventTypeFor } from '../../../domains/events/canonicalNormalizer'
import { loadPylonCompute } from '../pylonCompute'

const compute = await loadPylonCompute()

describe('计算核装载', () => {
  it('在 Node 宿主上装载成功（浏览器路径同构由 dev 预览覆盖）', () => {
    expect(typeof compute.canonicalEventTypes).toBe('function')
  })

  it('重复装载返回同一实例（幂等）', async () => {
    expect(await loadPylonCompute()).toBe(compute)
  })
})

describe('canonical 事件词表', () => {
  it('与 TS CANONICAL_EVENT_TYPES 逐项相等且顺序一致', () => {
    expect(compute.canonicalEventTypes()).toEqual([...CANONICAL_EVENT_TYPES])
  })

  it('isCanonicalEventType 与词表成员关系一致', () => {
    for (const eventType of CANONICAL_EVENT_TYPES) {
      expect(compute.isCanonicalEventType(eventType)).toBe(true)
    }
    for (const outsider of ['turn.started', 'session.json', 'interaction.resolved', '', 'UNKNOWN']) {
      expect(compute.isCanonicalEventType(outsider)).toBe(false)
    }
  })
})

describe('wire 判别符映射', () => {
  // 覆盖 ACP 全部已知判别符 + 一个未识别值 + 缺失值；status 覆盖 tool_call_update 的三个分支。
  const discriminators: (string | undefined)[] = [
    'user_message_chunk',
    'agent_message_chunk',
    'agent_thought_chunk',
    'tool_call',
    'tool_call_update',
    'done',
    'error',
    'cancelled',
    'usage_update',
    'plan',
    'current_mode_update',
    'session_info_update',
    'config_option_update',
    'available_commands_update',
    'brand_new_discriminator',
    undefined,
  ]
  const statuses: (string | undefined)[] = [undefined, 'completed', 'failed', 'error', 'in_progress']

  it('对每个判别符 × status 组合与 TS canonicalEventTypeFor 同判', () => {
    for (const sessionUpdate of discriminators) {
      for (const status of statuses) {
        expect(
          compute.canonicalEventTypeFor(sessionUpdate, status),
          `sessionUpdate=${sessionUpdate} status=${status}`,
        ).toBe(canonicalEventTypeFor(sessionUpdate, status))
      }
    }
  })

  it('未识别判别符归 unknown 而不是抛错', () => {
    expect(compute.canonicalEventTypeFor('brand_new_discriminator', undefined)).toBe('unknown')
    expect(compute.canonicalEventTypeFor(undefined, undefined)).toBe('unknown')
  })
})

describe('identity 推导', () => {
  const owners = [
    { profileId: 'p', agentId: 'a', localSessionId: 'l' },
    // 冒号在 source 里合法——这正是禁止冒号拼接的理由。
    { profileId: 'p', agentId: 'agent:with:colons', localSessionId: 'local:1' },
    // 含引号/转义字符，验证 JSON 编码而不是朴素拼接。
    { profileId: 'p"q', agentId: 'a\\b', localSessionId: 'l\nm' },
    { profileId: '配置', agentId: 'агент', localSessionId: '会话' },
  ]

  it('canonicalOwnerKey 与 TS toCanonicalOwnerKey 逐字节相等', () => {
    for (const owner of owners) {
      expect(
        compute.canonicalOwnerKey(owner.profileId, owner.agentId, owner.localSessionId),
      ).toBe(toCanonicalOwnerKey(owner))
    }
  })

  it('canonicalEventId 与 TS toCanonicalEventId 逐字节相等', () => {
    for (const owner of owners) {
      for (const sequence of [1, 3, 42, 9007199254740991]) {
        expect(compute.canonicalEventId(toCanonicalOwnerKey(owner), sequence)).toBe(
          toCanonicalEventId(owner, sequence),
        )
      }
    }
  })

  it('nextEventSequence 与 TS 同判（含首事件起点）', () => {
    for (const previous of [undefined, 1, 2, 41]) {
      expect(compute.nextEventSequence(previous)).toBe(nextEventSequence(previous))
    }
  })

  it('非整数 sequence 报错而不是静默截断', () => {
    // WASM 侧比 TS 严：TS 会算出 "key#3.5" 这种非法 eventId，Rust 直接拒。
    // 这是刻意的 fail-closed——sequence 由契约规定为正整数。
    expect(() => compute.canonicalEventId('["p","a","l"]', 3.5)).toThrow()
    expect(() => compute.nextEventSequence(0.5)).toThrow()
  })
})
