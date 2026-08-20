/**
 * I14-W5 UserDataRepository tauri adapter 测试（W5 消费侧写穿）：
 * - 首次保存前先读 revision baseline，再以 expected=baseline 保存
 * - per-key 串行：第二次保存等待第一次完成后带推进后的 expected
 * - 尾部合并：在飞期间新 envelope 覆盖旧批次（latest wins，只落一次最新 payload）
 * - 结构化错误透传（revision_conflict 等，code 分支依据）
 * - load 返回 envelope 并推进 baseline
 * - profiles / sessions 队列独立（各自 baseline）
 * - selectUserDataRepository 非 Tauri 环境返回 null
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}))

import {
  asUserDataRepositoryError,
  selectUserDataRepository,
  tauriUserDataRepository,
} from '../userDataRepository'

function profilesEnvelope(name: string) {
  return { version: 1, profiles: [{ id: 'p1', name, persona: 'p', model: 'm' }], activeProfileId: 'p1' }
}

function sessionsEnvelope(id: string, agentId: string) {
  return { version: 2, sessions: [{ id, agentId, name: 'n', source: 's', profileId: 'p1' }] }
}

describe('tauriUserDataRepository', () => {
  beforeEach(() => {
    invokeMock.mockReset()
  })

  it('flush 等待在飞/排队写落定（关闭前 flush 语义）', async () => {
    let releaseLoad!: () => void
    const loadGate = new Promise<void>((resolve) => { releaseLoad = resolve })
    invokeMock.mockImplementation(async (cmd) => {
      // 两条串行链并发启动时 invoke 顺序不确定：按命令返回，避免 once 队列错位
      if (cmd === 'user_data_load') {
        await loadGate
        return null
      }
      return { revision: 1 }
    })
    const repo = tauriUserDataRepository()
    const profiles = repo.save('profiles', profilesEnvelope('a'))
    const sessions = repo.save('sessions', sessionsEnvelope('s1', 'peri'))
    const flushed = repo.flush()
    releaseLoad()
    await flushed
    await Promise.all([profiles, sessions])
    const saves = invokeMock.mock.calls.filter(([cmd]) => cmd === 'user_data_save')
    expect(saves).toHaveLength(2)
  })

  it('flush 传播最后一次未恢复的写失败，不能把关闭 drain 报告为成功', async () => {
    invokeMock
      .mockResolvedValueOnce(null)
      .mockRejectedValue({ code: 'user_data_corrupt', message: 'payload corrupt' })
    const repo = tauriUserDataRepository()
    await expect(repo.save('profiles', profilesEnvelope('a'))).rejects.toMatchObject({
      code: 'user_data_corrupt',
    })
    await expect(repo.flush()).rejects.toMatchObject({ code: 'user_data_corrupt' })
  })

  it('首次保存先读 revision baseline，再以 expected=0 保存', async () => {
    invokeMock
      .mockResolvedValueOnce(null)               // user_data_load → 无数据
      .mockResolvedValueOnce({ revision: 1 })    // user_data_save → rev 1
    const repo = tauriUserDataRepository()
    const revision = await repo.save('profiles', profilesEnvelope('a'))
    expect(revision).toBe(1)
    expect(invokeMock).toHaveBeenCalledTimes(2)
    expect(invokeMock.mock.calls[0][0]).toBe('user_data_load')
    expect(invokeMock.mock.calls[0][1]).toEqual({ key: 'profiles' })
    expect(invokeMock.mock.calls[1][0]).toBe('user_data_save')
    const args = invokeMock.mock.calls[1][1] as { key: string; expectedRevision: number; payload: unknown }
    expect(args.key).toBe('profiles')
    expect(args.expectedRevision).toBe(0)
    expect(args.payload).toEqual(profilesEnvelope('a'))
  })

  it('串行队列：第二次保存带推进后的 expected（baseline 来自第一次返回）', async () => {
    invokeMock
      .mockResolvedValueOnce(null)               // load → 无数据
      .mockResolvedValueOnce({ revision: 1 })    // save1 → 1
      .mockResolvedValueOnce({ revision: 2 })    // save2 → 2
    const repo = tauriUserDataRepository()
    expect(await repo.save('profiles', profilesEnvelope('a'))).toBe(1)
    expect(await repo.save('profiles', profilesEnvelope('b'))).toBe(2)
    expect(invokeMock).toHaveBeenCalledTimes(3)
    const saves = invokeMock.mock.calls.filter(([cmd]) => cmd === 'user_data_save')
    expect(saves).toHaveLength(2)
    expect(saves[0][1].expectedRevision).toBe(0)
    expect(saves[1][1].expectedRevision).toBe(1)
  })

  it('尾部合并：在飞期间新 envelope 覆盖旧批次，只落一次最新 payload', async () => {
    let releaseLoad!: () => void
    const loadGate = new Promise<void>((resolve) => { releaseLoad = resolve })
    invokeMock
      .mockImplementationOnce(() => loadGate.then(() => null))   // load 挂起至 release
      .mockResolvedValueOnce({ revision: 1 })                    // save → 1
    const repo = tauriUserDataRepository()
    const first = repo.save('sessions', sessionsEnvelope('s1', 'peri'))
    const second = repo.save('sessions', sessionsEnvelope('s2', 'vega'))
    releaseLoad()
    expect(await Promise.all([first, second])).toEqual([1, 1])
    const saves = invokeMock.mock.calls.filter(([cmd]) => cmd === 'user_data_save')
    expect(saves).toHaveLength(1)
    const sessions = (saves[0][1].payload as { sessions: Array<{ id: string }> }).sessions
    expect(sessions).toEqual([{ id: 's2', agentId: 'vega', name: 'n', source: 's', profileId: 'p1' }])
  })

  it('revision conflict 结构化错误透传 code（旧写不覆盖新写）', async () => {
    const conflict = { code: 'user_data_revision_conflict', message: '用户数据 revision 冲突：期望 1，实际 2' }
    invokeMock.mockResolvedValueOnce(null).mockRejectedValueOnce(conflict)
    const repo = tauriUserDataRepository()
    const error = await repo.save('profiles', profilesEnvelope('a')).then(
      () => { throw new Error('save 应当 reject') },
      (e: unknown) => e,
    )
    expect(error).toMatchObject({ code: 'user_data_revision_conflict' })
    expect(asUserDataRepositoryError(error).message).toContain('revision 冲突')
  })

  it('load 返回 envelope 并推进 baseline（后续 save 以它为 expected）', async () => {
    invokeMock
      .mockResolvedValueOnce({ version: 2, revision: 3, payload: { version: 2, sessions: [] } })
      .mockResolvedValueOnce({ revision: 4 })
    const repo = tauriUserDataRepository()
    const envelope = await repo.load('sessions')
    expect(envelope?.revision).toBe(3)
    await repo.save('sessions', sessionsEnvelope('s1', 'peri'))
    const save = invokeMock.mock.calls.find(([cmd]) => cmd === 'user_data_save')
    expect(save![1].expectedRevision).toBe(3)
  })

  it('profiles 与 sessions 队列独立（各自 baseline，互不串扰）', async () => {
    invokeMock
      .mockResolvedValueOnce({ version: 1, revision: 5, payload: { version: 1, profiles: [], activeProfileId: '' } })
      .mockResolvedValueOnce({ revision: 6 })   // profiles save（expected 5）
      .mockResolvedValueOnce(null)              // sessions load → 无数据
      .mockResolvedValueOnce({ revision: 1 })   // sessions save（expected 0）
    const repo = tauriUserDataRepository()
    await repo.load('profiles')
    await repo.save('profiles', profilesEnvelope('a'))
    await repo.save('sessions', sessionsEnvelope('s1', 'peri'))
    const saves = invokeMock.mock.calls.filter(([cmd]) => cmd === 'user_data_save')
    expect(saves).toHaveLength(2)
    expect(saves[0][1].expectedRevision).toBe(5)
    expect(saves[1][1].expectedRevision).toBe(0)
  })

  it('I14-W6 CR-002：load 纳入串行链——在飞 save 期间 load 等待 save 完成后读最新状态', async () => {
    let releaseSave!: (value: unknown) => void
    const saveGate = new Promise((resolve) => { releaseSave = resolve })
    invokeMock
      .mockResolvedValueOnce(null)                                   // save baseline load
      .mockImplementationOnce(() => saveGate.then(() => ({ revision: 1 })))  // user_data_save 挂起
      .mockResolvedValueOnce({ version: 1, revision: 1, payload: { version: 1, profiles: [], activeProfileId: '' } })  // load 等待后
    const repo = tauriUserDataRepository()
    const saving = repo.save('profiles', profilesEnvelope('a'))
    const loading = repo.load('profiles')
    releaseSave({ revision: 1 })
    await Promise.all([saving, loading])
    // 顺序：baseline load → save → 我们的 load（在 save 完成后）
    const commands = invokeMock.mock.calls.map(([cmd]) => cmd)
    expect(commands).toEqual(['user_data_load', 'user_data_save', 'user_data_load'])
    const loads = invokeMock.mock.calls.filter(([cmd]) => cmd === 'user_data_load')
    expect(loads[1][1].key).toBe('profiles')
  })

  it('I14-W6 CR-007：revision conflict 后刷新 baseline，下一次 save 用新 expected', async () => {
    invokeMock
      .mockResolvedValueOnce(null)                                   // 首次 baseline load → 无数据
      .mockRejectedValueOnce({ code: 'user_data_revision_conflict', message: '冲突' })  // save1 冲突
      .mockResolvedValueOnce({ version: 1, revision: 5, payload: { version: 1, profiles: [], activeProfileId: '' } })  // 刷新 baseline load
      .mockResolvedValueOnce({ revision: 6 })                        // save2（expected 5）→ 6
    const repo = tauriUserDataRepository()
    const error = await repo.save('profiles', profilesEnvelope('a')).then(
      () => { throw new Error('save 应当 reject') },
      (e: unknown) => e,
    )
    expect(error).toMatchObject({ code: 'user_data_revision_conflict' })
    // 冲突后 baseline 已刷新为 5：下一次 save expected=5
    expect(await repo.save('profiles', profilesEnvelope('b'))).toBe(6)
    const saves = invokeMock.mock.calls.filter(([cmd]) => cmd === 'user_data_save')
    expect(saves).toHaveLength(2)
    expect(saves[0][1].expectedRevision).toBe(0)
    expect(saves[1][1].expectedRevision).toBe(5)
  })

  it('revision conflict 后保留同一最新快照，flush 使用刷新后的 baseline 重试', async () => {
    invokeMock
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce({ code: 'user_data_revision_conflict', message: '冲突' })
      .mockResolvedValueOnce({ version: 1, revision: 5, payload: { version: 1, profiles: [], activeProfileId: '' } })
      .mockResolvedValueOnce({ revision: 6 })
    const repo = tauriUserDataRepository()
    const payload = profilesEnvelope('latest')
    await expect(repo.save('profiles', payload)).rejects.toMatchObject({
      code: 'user_data_revision_conflict',
    })
    await expect(repo.flush()).resolves.toBeUndefined()

    const saves = invokeMock.mock.calls.filter(([cmd]) => cmd === 'user_data_save')
    expect(saves).toHaveLength(2)
    expect(saves[1][1]).toMatchObject({
      key: 'profiles',
      payload,
      expectedRevision: 5,
    })
  })

  it('权威 load 丢弃失败 pending，后续 flush 不得重放陈旧全量快照', async () => {
    invokeMock
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce({ code: 'user_data_revision_conflict', message: '冲突' })
      .mockResolvedValueOnce({ version: 1, revision: 5, payload: profilesEnvelope('sqlite') })
      .mockResolvedValueOnce({ version: 1, revision: 5, payload: profilesEnvelope('sqlite') })
    const repo = tauriUserDataRepository()
    await expect(repo.save('profiles', profilesEnvelope('stale-cache'))).rejects.toMatchObject({
      code: 'user_data_revision_conflict',
    })

    const authoritative = await repo.load('profiles')
    expect(authoritative?.payload).toEqual(profilesEnvelope('sqlite'))
    await expect(repo.flush()).resolves.toBeUndefined()

    const saves = invokeMock.mock.calls.filter(([cmd]) => cmd === 'user_data_save')
    expect(saves).toHaveLength(1)
  })

  it('启动竞态：user_data_unavailable 自动重试直到写穿成功，不丢会话', async () => {
    // 首次 baseline load 失败（service 未就绪）→ 重试后 load 成功；save 再 unavailable → 重试后成功。
    invokeMock
      .mockRejectedValueOnce({ code: 'user_data_unavailable', message: 'db unavailable' })   // baseline load 失败
      .mockResolvedValueOnce(null)                                                            // 重试 load → 无数据
      .mockRejectedValueOnce({ code: 'user_data_unavailable', message: 'db unavailable' })   // save 失败
      .mockResolvedValueOnce({ revision: 1 })                                                 // 重试 save → 成功
    const repo = tauriUserDataRepository()
    const revision = await repo.save('sessions', sessionsEnvelope('s1', 'peri'))
    expect(revision).toBe(1)
    // 共 4 次 invoke：2×load + 2×save
    const saves = invokeMock.mock.calls.filter(([cmd]) => cmd === 'user_data_save')
    const loads = invokeMock.mock.calls.filter(([cmd]) => cmd === 'user_data_load')
    expect(saves).toHaveLength(2)
    expect(loads).toHaveLength(2)
  })

  it('user_data_unavailable 重试耗尽仍失败 → 上报且 reject', async () => {
    // baseline load 成功（无数据），但 save 持续 unavailable，超过 MAX_SAVE_RETRY。
    invokeMock
      .mockResolvedValueOnce(null)   // load
      .mockRejectedValue({ code: 'user_data_unavailable', message: 'db unavailable' })  // save 一直失败
    const repo = tauriUserDataRepository()
    const error = await repo.save('sessions', sessionsEnvelope('s1', 'peri')).then(
      () => { throw new Error('save 应当 reject') },
      (e: unknown) => e,
    )
    expect(error).toMatchObject({ code: 'user_data_unavailable' })
    // 重试次数有界（不应无限）——load 1 + load(失败) 之间，save 调用次数受 MAX_SAVE_RETRY 约束
    const saves = invokeMock.mock.calls.filter(([cmd]) => cmd === 'user_data_save')
    expect(saves.length).toBeLessThanOrEqual(12)
  })
})

describe('selectUserDataRepository', () => {
  it('非 Tauri 环境返回 null（browser 模式 identityStore 直接读写 localStorage）', () => {
    expect(selectUserDataRepository()).toBeNull()
  })
})
