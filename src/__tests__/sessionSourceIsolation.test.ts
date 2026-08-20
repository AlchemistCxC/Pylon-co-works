/**
 * ISSUE-06 会话隔离：source 唯一性（agentId/profile 隔离的根本）。
 * addSession 的 source 必须全局唯一——'local:' + name 在同 agent 同名会话
 * （自动命名 / 跨 profile 同名）下冲突 → controller/runtime 状态按
 * AgentContextKey（agentId+source）键控会串会话（复读/串消息）。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { useIdentityStore } from '../identityStore'
import { resetStores } from '../test/resetStores'

beforeEach(() => {
  localStorage.clear()
  resetStores()
  useIdentityStore.setState({
    agents: [{ id: 'peri', name: 'Peri' }],
    activeAgent: 'peri',
    profiles: [
      { id: 'p1', name: 'Profile A', persona: 'p', model: 'm' },
      { id: 'p2', name: 'Profile B', persona: 'p', model: 'm' },
    ],
  })
})

describe('addSession source 唯一性（隔离）', () => {
  it('同 agent 同名会话 → source 不同（不串）', () => {
    useIdentityStore.setState({ activeProfileId: 'p1' })
    const a = useIdentityStore.getState().addSession('新会话', 'peri')
    const b = useIdentityStore.getState().addSession('新会话', 'peri')
    const sa = useIdentityStore.getState().sessions.find(s => s.id === a)!
    const sb = useIdentityStore.getState().sessions.find(s => s.id === b)!
    expect(sa.source).not.toBe(sb.source)
  })

  it('跨 profile 同名会话 → source 不同（agentId+profile 隔离）', () => {
    useIdentityStore.setState({ activeProfileId: 'p1' })
    const a = useIdentityStore.getState().addSession('工作', 'peri')
    useIdentityStore.setState({ activeProfileId: 'p2' })
    const b = useIdentityStore.getState().addSession('工作', 'peri')
    const sa = useIdentityStore.getState().sessions.find(s => s.id === a)!
    const sb = useIdentityStore.getState().sessions.find(s => s.id === b)!
    expect(sa.profileId).toBe('p1')
    expect(sb.profileId).toBe('p2')
    expect(sa.source).not.toBe(sb.source)
  })

  it('改名不改变 source（会话标识稳定）', () => {
    useIdentityStore.setState({ activeProfileId: 'p1' })
    const id = useIdentityStore.getState().addSession('初始名', 'peri')
    useIdentityStore.getState().updateSession(id, { name: '自动命名后的名字' })
    const s = useIdentityStore.getState().sessions.find(x => x.id === id)!
    expect(s.name).toBe('自动命名后的名字')
    expect(s.source).toBe(`local:${id}`)
  })

  it('分叉创建独立 owner，保留原归属与配置且不覆盖远端绑定', () => {
    useIdentityStore.setState({ activeProfileId: 'p1' })
    const originalId = useIdentityStore.getState().addSession('工作', 'peri', {
      workdir: 'G:/workspace',
      workspaceId: 'workspace-a',
      skills: ['review'],
      hooks: ['session.start'],
    })
    useIdentityStore.getState().updateSession(originalId, {
      periId: 'remote-original',
      sessionPrompt: '保持严谨',
      commandSetPlugins: ['builtin.pylon-core-command-set', 'third.party'],
    })
    useIdentityStore.setState({ activeProfileId: 'p2' })

    const forkId = useIdentityStore.getState().forkSession(originalId)
    const original = useIdentityStore.getState().sessions.find(session => session.id === originalId)!
    const fork = useIdentityStore.getState().sessions.find(session => session.id === forkId)!

    expect(forkId).not.toBe(originalId)
    expect(fork.source).toBe(`local:${forkId}`)
    expect(fork.source).not.toBe(original.source)
    expect(fork.periId).toBeUndefined()
    expect(original.periId).toBe('remote-original')
    expect(fork).toMatchObject({
      agentId: original.agentId,
      profileId: 'p1',
      platform: 'local',
      workdir: original.workdir,
      workspaceId: original.workspaceId,
      sessionPrompt: original.sessionPrompt,
      skills: original.skills,
      hooks: original.hooks,
      commandSetPlugins: original.commandSetPlugins,
    })
    expect(fork.creationSnapshot).toBeDefined()
    expect(fork.creationSnapshot).not.toBe(original.creationSnapshot)
  })
})
