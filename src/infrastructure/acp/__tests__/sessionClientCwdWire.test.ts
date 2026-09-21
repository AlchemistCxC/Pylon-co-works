// @vitest-environment node

/**
 * CWD-02/03 行为化：sessionClient 的 new_session / load_persisted_session 载荷必须同时携带
 * cwd（legacy 兼容维，CWD-03 起由后端绑定 Workspace 时以 root_path 覆盖）与
 * workspaceId（CWD-03 方案 C：Workspace 实体绑定维）。
 *
 * 原 readFileSync 源码锁与行号级证据登记（file:line）退役——wire 契约改由 typed client
 * 真实 invoke 载荷行为锁定（经 FakeInvoke 传输）。
 *
 * #228 批次B：自 src/cwd02/ 迁入（紧贴被锁的 sessionClient）；cwd02 目录随一次性基线
 * 常量（cwdWireBaseline.ts，迁移已完成、零引用）一并删除，本行为锁保留持续回归价值。
 */

import { describe, expect, it } from 'vitest'
import { FakeInvoke } from '../../../test/fakeInvoke'
import { createSessionClient } from '../sessionClient'

describe('CWD wire：sessionClient 载荷携 cwd/workspaceId', () => {
  it('new_session 载荷同时携带 cwd 与 workspaceId（命令名 new_session）', async () => {
    const invoke = new FakeInvoke().register('new_session', () => ({ sessionId: 'remote-1' }))
    const client = createSessionClient({ invoke: (cmd, args) => invoke.invoke(cmd, args) })
    await client.newSession({
      agentId: 'peri',
      profileId: 'profile-a',
      source: 'local:一',
      cwd: 'C:/workspace',
      workspaceId: 'ws-1',
    })
    // 两个绑定维必须出现在同一次 new_session 载荷中（精确相等，字段不得漂移）
    expect(invoke.calls).toEqual([{
      cmd: 'new_session',
      args: {
        agentId: 'peri',
        profileId: 'profile-a',
        source: 'local:一',
        cwd: 'C:/workspace',
        workspaceId: 'ws-1',
      },
    }])
  })

  it('load_persisted_session 载荷同时携带 cwd 与 workspaceId（命令名 load_persisted_session）', async () => {
    const invoke = new FakeInvoke().register('load_persisted_session', () => null)
    const client = createSessionClient({ invoke: (cmd, args) => invoke.invoke(cmd, args) })
    const owner = { profileId: 'profile-a', agentId: 'peri', localSessionId: 'local:一' }
    await client.loadPersistedSession({
      owner,
      periId: 'remote-99',
      cwd: 'C:/workspace',
      workspaceId: 'ws-1',
    })
    expect(invoke.calls).toEqual([{
      cmd: 'load_persisted_session',
      args: {
        owner,
        periId: 'remote-99',
        cwd: 'C:/workspace',
        workspaceId: 'ws-1',
      },
    }])
  })
})
