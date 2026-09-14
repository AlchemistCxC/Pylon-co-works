// 迁移自 scripts/test-session-profile.mts（P91 A1）。
// profile 归属契约：resolveSessionProfile 按会话 id / source 解析、无会话 id 返回
// undefined；belongsToProfile 匹配判定与「无会话 id 恒归属」。逐断言平移。
// 夹具相对原脚本仅补 Session.v2 必填的 agentId（schema 漂移，断言不变）。
import { describe, expect, it } from 'vitest'
import { belongsToProfile, resolveSessionProfile } from '../sessionProfile.ts'
import type { Profile, Session } from '../../../store.ts'

const profiles: Profile[] = [
  { id: 'a', name: 'A', persona: 'persona-a', model: 'model-a' },
  { id: 'b', name: 'B', persona: 'persona-b', model: 'model-b' },
]
const sessions: Session[] = [
  { id: 'local-a', agentId: 'agent-a', name: 'A', source: 'source-a', profileId: 'a', createdAt: 1, lastActiveAt: 1, platform: 'local', workdir: '', sessionPrompt: '', skills: [], hooks: [], autoName: '' },
  { id: 'local-b', agentId: 'agent-b', name: 'B', source: 'source-b', profileId: 'b', createdAt: 1, lastActiveAt: 1, platform: 'local', workdir: '', sessionPrompt: '', skills: [], hooks: [], autoName: '' },
]

describe('sessionProfile 归属（原 test-session-profile.mts）', () => {
  it('按会话 id 与 source 解析 profile；无会话 id 返回 undefined', () => {
    expect(resolveSessionProfile('local-a', sessions, profiles)?.persona).toBe('persona-a')
    expect(resolveSessionProfile('source-b', sessions, profiles)?.persona).toBe('persona-b')
    expect(resolveSessionProfile(null, sessions, profiles)).toBeUndefined()
  })

  it('belongsToProfile：按 source 匹配/不匹配；无会话 id 恒归属', () => {
    expect(belongsToProfile('local-a', 'a', sessions)).toBe(true)
    expect(belongsToProfile('local-a', 'b', sessions)).toBe(false)
    expect(belongsToProfile(null, 'b', sessions)).toBe(true)
  })
})
