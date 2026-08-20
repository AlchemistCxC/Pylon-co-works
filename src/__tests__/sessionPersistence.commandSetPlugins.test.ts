import { describe, expect, it } from 'vitest'
import { parseSessions, serializeSessions } from '../sessionPersistence'
import { CORE_COMMAND_SET_PLUGIN_ID } from '../contracts/agentCommandSet'
import type { Session } from '../identityStore'

const profiles = [{ id: 'p1', name: 'P', persona: 'p', model: 'm' }]

function session(commandSetPlugins?: string[]): Session {
  return {
    id: 's1',
    agentId: 'peri',
    name: 'S',
    source: 'local:s1',
    profileId: 'p1',
    createdAt: 1,
    lastActiveAt: 2,
    platform: 'local',
    workdir: '',
    sessionPrompt: '',
    skills: [],
    hooks: [],
    ...(commandSetPlugins ? { commandSetPlugins } : {}),
    autoName: '',
  }
}

describe('Session.commandSetPlugins 持久化（M2）', () => {
  it('显式启用集合 roundtrip 保留', () => {
    const result = parseSessions(serializeSessions([session([CORE_COMMAND_SET_PLUGIN_ID])]), profiles)
    expect(result.kind).toBe('ready')
    if (result.kind === 'ready') {
      expect(result.sessions[0].commandSetPlugins).toEqual([CORE_COMMAND_SET_PLUGIN_ID])
    }
  })

  it('旧数据缺省字段归一化为 undefined（resolver 按全部 active 处理）', () => {
    const result = parseSessions(serializeSessions([session()]), profiles)
    expect(result.kind).toBe('ready')
    if (result.kind === 'ready') {
      expect(result.sessions[0].commandSetPlugins).toBeUndefined()
    }
  })
})
