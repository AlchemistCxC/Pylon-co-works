/**
 * TS-WI02：unresolved owner resolution transaction contract。
 *
 * 恢复必须读取最新 unresolved、校验 Agent、成功后才提交 owner；取消和失败不改变现场。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveUnresolvedSessionTransaction } from '../resolveUnresolvedSessionTransaction'
import type { LegacySession } from '../../../sessionPersistence'

type Agent = { id: string; name: string }

const unresolved: LegacySession = {
  id: 'legacy-1', name: '遗留会话', source: 'qq:group:1', profileId: 'profile-a',
  createdAt: 1, lastActiveAt: 2, platform: 'qq', workdir: '', sessionPrompt: '', skills: [], hooks: [], autoName: '',
}

const agents: Agent[] = [{ id: 'peri', name: 'Peri' }]

function deps() {
  return {
    getUnresolved: vi.fn(() => [unresolved]),
    getAgents: vi.fn(() => agents),
    commit: vi.fn(async (_session: LegacySession, _agentId: string) => undefined),
  }
}

describe('TS-WI02 unresolved owner resolution transaction', () => {
  beforeEach(() => vi.clearAllMocks())

  it('指定有效 Agent 后提交 owner', async () => {
    const d = deps()
    const result = await resolveUnresolvedSessionTransaction('legacy-1', 'peri', d)
    expect(result).toEqual({ ok: true, value: 'legacy-1' })
    expect(d.commit).toHaveBeenCalledWith(unresolved, 'peri')
  })

  it('读取不到最新 unresolved 时拒绝提交', async () => {
    const d = deps()
    d.getUnresolved.mockReturnValue([])
    const result = await resolveUnresolvedSessionTransaction('legacy-1', 'peri', d)
    expect(result).toMatchObject({ ok: false, kind: 'validation' })
    expect(d.commit).not.toHaveBeenCalled()
  })

  it('Agent 已不存在时保留 unresolved', async () => {
    const d = deps()
    d.getAgents.mockReturnValue([])
    const result = await resolveUnresolvedSessionTransaction('legacy-1', 'peri', d)
    expect(result).toMatchObject({ ok: false, kind: 'validation' })
    expect(d.commit).not.toHaveBeenCalled()
  })

  it('提交失败返回 transport，现场仍由调用方保留', async () => {
    const d = deps()
    d.commit.mockRejectedValue(new Error('保存失败'))
    const result = await resolveUnresolvedSessionTransaction('legacy-1', 'peri', d)
    expect(result).toMatchObject({ ok: false, kind: 'transport', message: '保存失败' })
  })
})
