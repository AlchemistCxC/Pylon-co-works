/**
 * owner — AgentSessionOwner contract 的纯域单测（OWNER-01 §5.8）。
 *
 * 覆盖：key 序列化纪律（JSON 数组、禁止冒号拼接——source 可含冒号）、
 * profileId 可选语义、owner 唯一性（agentId+source 区分双 Agent 同名 source）。
 */

import { describe, expect, it } from 'vitest'
import { toDurableSessionOwnerKey, toSessionOwnerKey, type SessionOwner } from '../owner.ts'

describe('SessionOwner key', () => {
  it('双 Agent 同名 source 产生不同 owner key（不串线）', () => {
    const peri = toSessionOwnerKey({ agentId: 'peri', source: 'shared-source' })
    const hermes = toSessionOwnerKey({ agentId: 'hermes', source: 'shared-source' })
    expect(peri).not.toBe(hermes)
  })

  it('source 含冒号时 key 仍无歧义（禁止 a:b:c 拼接）', () => {
    const owner = toSessionOwnerKey({ agentId: 'peri', source: 'qq:123' })
    expect(owner).toBe(JSON.stringify(['peri', 'qq:123']))
    // 若误用 ${agentId}:${source} 拼接，"peri:qq:123" 与 "per:iq:q:123" 等无法区分——
    // JSON 数组序列化下同一 source 只有一种编码。
    expect(owner).not.toBe('peri:qq:123')
  })

  it('profileId 可选且参与 key（显式 profile 维）', () => {
    const noProfile = toSessionOwnerKey({ agentId: 'peri', source: 's' })
    const withProfile = toSessionOwnerKey({ agentId: 'peri', source: 's', profileId: 'p-a' })
    expect(noProfile).toBe(JSON.stringify(['peri', 's']))
    expect(withProfile).toBe(JSON.stringify(['p-a', 'peri', 's']))
    expect(noProfile).not.toBe(withProfile)
  })

  it('同 key 幂等（纯函数）', () => {
    const owner: SessionOwner = { agentId: 'hermes', source: 'src' }
    expect(toSessionOwnerKey(owner)).toBe(toSessionOwnerKey({ ...owner }))
  })
})

describe('DurableSessionOwner key', () => {
  it('与 canonical journal 共用 profile/agent/local 三元组序列化', () => {
    expect(toDurableSessionOwnerKey({
      profileId: 'p1',
      agentId: 'peri',
      localSessionId: 'local:一',
    })).toBe('["p1","peri","local:一"]')
  })
})
