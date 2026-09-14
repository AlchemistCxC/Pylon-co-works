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
import { FakeInvoke } from '../test/fakeInvoke'

const { invokeRef } = vi.hoisted(() => ({
  invokeRef: { current: null as null | ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) },
}))
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) => invokeRef.current!(cmd, args),
}))

import {
  asUserDataRepositoryError,
  selectUserDataRepository,
  tauriUserDataRepository,
} from '../userDataRepository'

/** per-command once 队列：依次返回值；{ reject } 项抛出（对齐 mockRejectedValueOnce） */
function queue<T>(...steps: Array<T | { reject: unknown }>): () => T | undefined {
  const pending = [...steps]
  return () => {
    const step = pending.shift()
    if (step === undefined) return undefined
    if (typeof step === 'object' && step !== null && 'reject' in step) throw (step as { reject: unknown }).reject
    return step as T
  }
}

let fakeInvoke: FakeInvoke

beforeEach(() => {
  fakeInvoke = new FakeInvoke()
  invokeRef.current = (cmd, args) => fakeInvoke.invoke(cmd, args)
})

function profilesEnvelope(name: string) {
  return { version: 1, profiles: [{ id: 'p1', name, persona: 'p', model: 'm' }], activeProfileId: 'p1' }
}

function sessionsEnvelope(id: string, agentId: string) {
  return { version: 2, sessions: [{ id, agentId, name: 'n', source: 's', profileId: 'p1' }] }
}

describe('tauriUserDataRepository', () => {
  it('flush 等待在飞/排队写落定（关闭前 flush 语义）', async () => {
    let releaseLoad!: () => void
    const loadGate = new Promise<void>((resolve) => { releaseLoad = resolve })
    fakeInvoke.register('user_data_load', async () => {
      // 两条串行链并发启动时 invoke 顺序不确定：按命令返回，避免 once 队列错位
      await loadGate
      return null
    })
    fakeInvoke.register('user_data_save', () => ({ revision: 1 }))
    const repo = tauriUserDataRepository()
    const profiles = repo.save('profiles', profilesEnvelope('a'))
    const sessions = repo.save('sessions', sessionsEnvelope('s1', 'peri'))
    const flushed = repo.flush()
    releaseLoad()
    await flushed
    await Promise.all([profiles, sessions])
    expect(fakeInvoke.calls.filter(call => call.cmd === 'user_data_save')).toHaveLength(2)
  })

  it('flush 传播最后一次未恢复的写失败，不能把关闭 drain 报告为成功', async () => {
    const corrupt = { code: 'user_data_corrupt', message: 'payload corrupt' }
    fakeInvoke.register('user_data_load', queue(null))
    fakeInvoke.register('user_data_save', () => {
      throw corrupt
    })
    const repo = tauriUserDataRepository()
    await expect(repo.save('profiles', profilesEnvelope('a'))).rejects.toMatchObject({
      code: 'user_data_corrupt',
    })
    await expect(repo.flush()).rejects.toMatchObject({ code: 'user_data_corrupt' })
  })

  it('首次保存先读 revision baseline，再以 expected=0 保存', async () => {
    fakeInvoke.register('user_data_load', queue(null))               // user_data_load → 无数据
    fakeInvoke.register('user_data_save', queue({ revision: 1 }))          // user_data_save → rev 1
    const repo = tauriUserDataRepository()
    const revision = await repo.save('profiles', profilesEnvelope('a'))
    expect(revision).toBe(1)
    expect(fakeInvoke.calls).toHaveLength(2)
    expect(fakeInvoke.calls[0]?.cmd).toBe('user_data_load')
    expect(fakeInvoke.calls[0]?.args).toEqual({ key: 'profiles' })
    expect(fakeInvoke.calls[1]?.cmd).toBe('user_data_save')
    const args = fakeInvoke.calls[1]!.args as { key: string; expectedRevision: number; payload: unknown }
    expect(args.key).toBe('profiles')
    expect(args.expectedRevision).toBe(0)
    expect(args.payload).toEqual(profilesEnvelope('a'))
  })

  it('串行队列：第二次保存带推进后的 expected（baseline 来自第一次返回）', async () => {
    fakeInvoke.register('user_data_load', queue(null))                            // load → 无数据
    fakeInvoke.register('user_data_save', queue({ revision: 1 }, { revision: 2 }))      // save1 → 1, save2 → 2
    const repo = tauriUserDataRepository()
    expect(await repo.save('profiles', profilesEnvelope('a'))).toBe(1)
    expect(await repo.save('profiles', profilesEnvelope('b'))).toBe(2)
    expect(fakeInvoke.calls).toHaveLength(3)
    const saves = fakeInvoke.calls.filter(call => call.cmd === 'user_data_save')
    expect(saves).toHaveLength(2)
    expect((saves[0]!.args as { expectedRevision: number }).expectedRevision).toBe(0)
    expect((saves[1]!.args as { expectedRevision: number }).expectedRevision).toBe(1)
  })

  it('尾部合并：在飞期间新 envelope 覆盖旧批次，只落一次最新 payload', async () => {
    let releaseLoad!: () => void
    const loadGate = new Promise<void>((resolve) => { releaseLoad = resolve })
    fakeInvoke.register('user_data_load', () => loadGate.then(() => null))   // load 挂起至 release
    fakeInvoke.register('user_data_save', queue({ revision: 1 }))            // save → 1
    const repo = tauriUserDataRepository()
    const first = repo.save('sessions', sessionsEnvelope('s1', 'peri'))
    const second = repo.save('sessions', sessionsEnvelope('s2', 'vega'))
    releaseLoad()
    expect(await Promise.all([first, second])).toEqual([1, 1])
    const saves = fakeInvoke.calls.filter(call => call.cmd === 'user_data_save')
    expect(saves).toHaveLength(1)
    const sessions = (saves[0]!.args as { payload: { sessions: Array<{ id: string }> } }).payload.sessions
    expect(sessions).toEqual([{ id: 's2', agentId: 'vega', name: 'n', source: 's', profileId: 'p1' }])
  })

  it('revision conflict 结构化错误透传 code（旧写不覆盖新写）', async () => {
    const conflict = { code: 'user_data_revision_conflict', message: '用户数据 revision 冲突：期望 1，实际 2' }
    fakeInvoke.register('user_data_load', queue(null))
    fakeInvoke.register('user_data_save', queue({ reject: conflict }))
    const repo = tauriUserDataRepository()
    const error = await repo.save('profiles', profilesEnvelope('a')).then(
      () => { throw new Error('save 应当 reject') },
      (e: unknown) => e,
    )
    expect(error).toMatchObject({ code: 'user_data_revision_conflict' })
    expect(asUserDataRepositoryError(error).message).toContain('revision 冲突')
  })

  it('load 返回 envelope 并推进 baseline（后续 save 以它为 expected）', async () => {
    fakeInvoke.register('user_data_load', queue({ version: 2, revision: 3, payload: { version: 2, sessions: [] } }))
    fakeInvoke.register('user_data_save', queue({ revision: 4 }))
    const repo = tauriUserDataRepository()
    const envelope = await repo.load('sessions')
    expect(envelope?.revision).toBe(3)
    await repo.save('sessions', sessionsEnvelope('s1', 'peri'))
    const save = fakeInvoke.calls.find(call => call.cmd === 'user_data_save')
    expect((save!.args as { expectedRevision: number }).expectedRevision).toBe(3)
  })

  it('profiles 与 sessions 队列独立（各自 baseline，互不串扰）', async () => {
    fakeInvoke.register('user_data_load', queue(
      { version: 1, revision: 5, payload: { version: 1, profiles: [], activeProfileId: '' } },
      null,                                     // sessions load → 无数据
    ))
    fakeInvoke.register('user_data_save', queue(
      { revision: 6 },                          // profiles save（expected 5）
      { revision: 1 },                          // sessions save（expected 0）
    ))
    const repo = tauriUserDataRepository()
    await repo.load('profiles')
    await repo.save('profiles', profilesEnvelope('a'))
    await repo.save('sessions', sessionsEnvelope('s1', 'peri'))
    const saves = fakeInvoke.calls.filter(call => call.cmd === 'user_data_save')
    expect(saves).toHaveLength(2)
    expect((saves[0]!.args as { expectedRevision: number }).expectedRevision).toBe(5)
    expect((saves[1]!.args as { expectedRevision: number }).expectedRevision).toBe(0)
  })

  it('I14-W6 CR-002：load 纳入串行链——在飞 save 期间 load 等待 save 完成后读最新状态', async () => {
    let releaseSave!: (value: unknown) => void
    const saveGate = new Promise((resolve) => { releaseSave = resolve })
    fakeInvoke.register('user_data_load', queue(
      null,                                     // save baseline load
      { version: 1, revision: 1, payload: { version: 1, profiles: [], activeProfileId: '' } },  // load 等待后
    ))
    fakeInvoke.register('user_data_save', () => saveGate.then(() => ({ revision: 1 })))  // user_data_save 挂起
    const repo = tauriUserDataRepository()
    const saving = repo.save('profiles', profilesEnvelope('a'))
    const loading = repo.load('profiles')
    releaseSave({ revision: 1 })
    await Promise.all([saving, loading])
    // 顺序：baseline load → save → 我们的 load（在 save 完成后）
    expect(fakeInvoke.calls.map(call => call.cmd)).toEqual(['user_data_load', 'user_data_save', 'user_data_load'])
    const loads = fakeInvoke.calls.filter(call => call.cmd === 'user_data_load')
    expect((loads[1]!.args as { key: string }).key).toBe('profiles')
  })

  it('I14-W6 CR-007：revision conflict 后刷新 baseline，下一次 save 用新 expected', async () => {
    fakeInvoke.register('user_data_load', queue(
      null,                                     // 首次 baseline load → 无数据
      { version: 1, revision: 5, payload: { version: 1, profiles: [], activeProfileId: '' } },  // 刷新 baseline load
    ))
    fakeInvoke.register('user_data_save', queue(
      { reject: { code: 'user_data_revision_conflict', message: '冲突' } },  // save1 冲突
      { revision: 6 },                          // save2（expected 5）→ 6
    ))
    const repo = tauriUserDataRepository()
    const error = await repo.save('profiles', profilesEnvelope('a')).then(
      () => { throw new Error('save 应当 reject') },
      (e: unknown) => e,
    )
    expect(error).toMatchObject({ code: 'user_data_revision_conflict' })
    // 冲突后 baseline 已刷新为 5：下一次 save expected=5
    expect(await repo.save('profiles', profilesEnvelope('b'))).toBe(6)
    const saves = fakeInvoke.calls.filter(call => call.cmd === 'user_data_save')
    expect(saves).toHaveLength(2)
    expect((saves[0]!.args as { expectedRevision: number }).expectedRevision).toBe(0)
    expect((saves[1]!.args as { expectedRevision: number }).expectedRevision).toBe(5)
  })

  it('revision conflict 后保留同一最新快照，flush 使用刷新后的 baseline 重试', async () => {
    fakeInvoke.register('user_data_load', queue(
      null,
      { version: 1, revision: 5, payload: { version: 1, profiles: [], activeProfileId: '' } },
    ))
    fakeInvoke.register('user_data_save', queue(
      { reject: { code: 'user_data_revision_conflict', message: '冲突' } },
      { revision: 6 },
    ))
    const repo = tauriUserDataRepository()
    const payload = profilesEnvelope('latest')
    await expect(repo.save('profiles', payload)).rejects.toMatchObject({
      code: 'user_data_revision_conflict',
    })
    await expect(repo.flush()).resolves.toBeUndefined()

    const saves = fakeInvoke.calls.filter(call => call.cmd === 'user_data_save')
    expect(saves).toHaveLength(2)
    expect(saves[1]!.args).toMatchObject({
      key: 'profiles',
      payload,
      expectedRevision: 5,
    })
  })

  it('权威 load 丢弃失败 pending，后续 flush 不得重放陈旧全量快照', async () => {
    fakeInvoke.register('user_data_load', queue(
      null,
      { reject: { code: 'user_data_revision_conflict', message: '冲突' } },
      { version: 1, revision: 5, payload: profilesEnvelope('sqlite') },
      { version: 1, revision: 5, payload: profilesEnvelope('sqlite') },
    ))
    fakeInvoke.register('user_data_save', queue({
      reject: { code: 'user_data_revision_conflict', message: '冲突' },
    }))
    const repo = tauriUserDataRepository()
    await expect(repo.save('profiles', profilesEnvelope('stale-cache'))).rejects.toMatchObject({
      code: 'user_data_revision_conflict',
    })

    const authoritative = await repo.load('profiles')
    expect(authoritative?.payload).toEqual(profilesEnvelope('sqlite'))
    await expect(repo.flush()).resolves.toBeUndefined()

    expect(fakeInvoke.calls.filter(call => call.cmd === 'user_data_save')).toHaveLength(1)
  })

  it('启动竞态：user_data_unavailable 自动重试直到写穿成功，不丢会话', async () => {
    // 首次 baseline load 失败（service 未就绪）→ 重试后 load 成功；save 再 unavailable → 重试后成功。
    fakeInvoke.register('user_data_load', queue(
      { reject: { code: 'user_data_unavailable', message: 'db unavailable' } },   // baseline load 失败
      null,                                                                        // 重试 load → 无数据
    ))
    fakeInvoke.register('user_data_save', queue(
      { reject: { code: 'user_data_unavailable', message: 'db unavailable' } },   // save 失败
      { revision: 1 },                                                            // 重试 save → 成功
    ))
    const repo = tauriUserDataRepository()
    const revision = await repo.save('sessions', sessionsEnvelope('s1', 'peri'))
    expect(revision).toBe(1)
    // 共 4 次 invoke：2×load + 2×save
    expect(fakeInvoke.calls.filter(call => call.cmd === 'user_data_save')).toHaveLength(2)
    expect(fakeInvoke.calls.filter(call => call.cmd === 'user_data_load')).toHaveLength(2)
  })

  it('user_data_unavailable 重试耗尽仍失败 → 上报且 reject', async () => {
    // baseline load 成功（无数据），但 save 持续 unavailable，超过 MAX_SAVE_RETRY。
    fakeInvoke.register('user_data_load', queue(null))   // load
    fakeInvoke.register('user_data_save', () => {
      throw { code: 'user_data_unavailable', message: 'db unavailable' }  // save 一直失败
    })
    const repo = tauriUserDataRepository()
    const error = await repo.save('sessions', sessionsEnvelope('s1', 'peri')).then(
      () => { throw new Error('save 应当 reject') },
      (e: unknown) => e,
    )
    expect(error).toMatchObject({ code: 'user_data_unavailable' })
    // 重试次数有界（不应无限）——load 1 + load(失败) 之间，save 调用次数受 MAX_SAVE_RETRY 约束
    const saves = fakeInvoke.calls.filter(call => call.cmd === 'user_data_save')
    expect(saves.length).toBeLessThanOrEqual(12)
  })
})

describe('selectUserDataRepository', () => {
  it('非 Tauri 环境返回 null（browser 模式 identityStore 直接读写 localStorage）', () => {
    expect(selectUserDataRepository()).toBeNull()
  })
})
