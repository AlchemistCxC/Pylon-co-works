// @vitest-environment node

/**
 * CWD-02/03：ACP cwd wire 取证测试（方案书任务表 CWD-02，§5.16——new/load wire 现状；
 * CWD-03 迁移后三个结构性常量全部翻转为 true）。
 *
 * 覆盖两组回归门：
 *   1. 结构性常量 + 证据登记（CWD_WIRE_EVIDENCE file:line/shape/note；三个结构性常量
 *      CWD_WIRE_CARRIES_CWD=true、WORKSPACE_ENTITY_BINDING_IN_PLACE=true（CWD-03 翻转）、
 *      WORKSPACE_ID_IN_EVENT_OWNER=true（CWD-03 翻转））。
 *   2. 源码锁（CWD-03 迁移后保持此 gate 的变红变绿）：
 *      - 前端：identityStore.ts Session.workdir + workspaceId?: string；sessionClient.ts
 *        NewSessionPayload / LoadPersistedSessionPayload 携带 cwd?: string 与 workspaceId?: string，
 *        invoke 命令名 new_session / load_persisted_session 存在；eventSchema.ts
 *        CanonicalEventOwner.workspaceId?: string。
 *      - 后端：create.rs new_session `workspace_id: Option<String>` + resolve_session_cwd +
 *        agent_cwd() fallback；persist.rs load_persisted_session 同构；workspaces.rs
 *        Workspace 实体 + resolve_session_cwd；model.rs SessionInfo.cwd + workspace_id；
 *        mod.rs workspace_root_for_context workspace 绑定优先 + session.cwd 回退；
 *        workspace_cmds.rs git_workspace_root 委托 workspace_root_for_source（Git 同链证据）。
 * 只读取证，不修改任何 wire 行为（CWD-01 已拍板方案 C；wire 迁移属 CWD-03，已完成）。
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  buildCwdWireBaselineArtifact,
  CWD_WIRE_CARRIES_CWD,
  cwdWireContract,
  CWD_WIRE_EVIDENCE,
  WORKSPACE_ENTITY_BINDING_IN_PLACE,
  WORKSPACE_ID_IN_EVENT_OWNER,
} from '../cwdWireBaseline'

declare const process: { cwd(): string }

function read(path: string): string {
  return readFileSync(`${process.cwd()}/${path}`, 'utf8')
}

describe('结构性常量与证据登记', () => {
  it('CWD-03 翻转基线：wire 携 cwd（true）、Workspace 实体绑定就位（true）、事件 owner 携 workspaceId（true）', () => {
    expect(CWD_WIRE_CARRIES_CWD).toBe(true) // new/load wire 携带 plain string cwd（兼容快照）
    expect(WORKSPACE_ENTITY_BINDING_IN_PLACE).toBe(true) // CWD-03 翻转：session 绑定 Workspace 实体
    expect(WORKSPACE_ID_IN_EVENT_OWNER).toBe(true) // CWD-03 翻转：EVT schema 扩 workspaceId
  })

  it('证据登记：前端 session/绑定/双 payload/owner，后端 new/load/workspace 解析/runtime/root/git 同链', () => {
    const ev = CWD_WIRE_EVIDENCE
    expect(ev.frontend.sessionWorkdir.file).toBe('src/identityStore.ts:40')
    expect(ev.frontend.sessionWorkdir.shape).toBe('Session.workdir: string')
    expect(ev.frontend.sessionWorkspaceBinding.file).toBe('src/identityStore.ts:43')
    expect(ev.frontend.sessionWorkspaceBinding.shape).toBe('Session.workspaceId?: string')
    expect(ev.frontend.newSessionPayload.file).toBe('src/infrastructure/acp/sessionClient.ts:17,19')
    expect(ev.frontend.loadPersistedPayload.file).toBe('src/infrastructure/acp/sessionClient.ts:30,32')
    expect(ev.frontend.eventOwnerWorkspaceId.file).toBe('src/domains/events/eventSchema.ts:25')
    expect(ev.backend.newSession.file).toBe('src-tauri/src/session/create.rs:191,216-217')
    expect(ev.backend.loadPersisted.file).toBe('src-tauri/src/session/persist.rs:19,29-30')
    expect(ev.backend.workspaceResolve.file).toBe('src-tauri/src/workspaces.rs:57,82')
    expect(ev.backend.runtimeSessionCwd.file).toBe('src-tauri/src/session/model.rs:12,31')
    expect(ev.backend.workspaceRootResolution.file).toBe('src-tauri/src/session/mod.rs:335,367')
    expect(ev.backend.gitWorkspaceRoot.file).toBe('src-tauri/src/workspace_cmds.rs:100-110')
    expect(ev.backend.workspaceCommands.file).toBe('src-tauri/src/workspace_cmds.rs:14-88')
  })
})

describe('cwdWireContract（new/load 全链流向）', () => {
  it('十一段流向按序登记，段/file/shape 三要素齐备', () => {
    const wire = cwdWireContract()
    expect(wire).toHaveLength(11)
    expect(wire.map(node => node.segment)).toEqual([
      'frontend-session',
      'frontend-workspace-binding',
      'new-session-payload',
      'load-persisted-payload',
      'backend-new-session',
      'backend-load-persisted',
      'backend-workspace-resolve',
      'runtime-session',
      'workspace-root',
      'git-root',
      'workspace-commands',
    ])
    for (const node of wire) {
      expect(node.file).toMatch(/^src[-/]/)
      expect(node.shape.length).toBeGreaterThan(0)
    }
    expect(wire[1].shape).toBe('Session.workspaceId?: string')
    expect(wire[6].shape).toMatch(/resolve_session_cwd/)
  })
})

describe('取证工件', () => {
  it('schemaVersion=1，wire 与 constants 完整', () => {
    const artifact = buildCwdWireBaselineArtifact()
    expect(artifact.schemaVersion).toBe(1)
    expect(artifact.wire).toHaveLength(11)
    expect(artifact.constants).toEqual({
      CWD_WIRE_CARRIES_CWD: true,
      WORKSPACE_ENTITY_BINDING_IN_PLACE: true,
      WORKSPACE_ID_IN_EVENT_OWNER: true,
    })
  })
})

describe('源码锁：wire 现状与证据一致（取证真实性）', () => {
  it('前端 identityStore.ts Session.workdir 字段与 workspaceId 绑定维存在', () => {
    expect(read('src/identityStore.ts')).toMatch(/workdir:\s*string/)
    expect(read('src/identityStore.ts')).toMatch(/workspaceId\?:\s*string/)
  })

  it('前端 sessionClient.ts：双 payload 携带 cwd?: string 与 workspaceId?: string，invoke new_session / load_persisted_session', () => {
    const source = read('src/infrastructure/acp/sessionClient.ts')
    expect(source).toContain('cwd?: string')
    expect(source).toContain('workspaceId?: string')
    expect(source).toMatch(/invoke\('new_session'/)
    expect(source).toMatch(/invoke\('load_persisted_session'/)
  })

  it('前端 eventSchema.ts CanonicalEventOwner.workspaceId?: string（owner 绑定维）', () => {
    const source = read('src/domains/events/eventSchema.ts')
    expect(source).toMatch(/interface CanonicalEventOwner/)
    expect(source).toMatch(/workspaceId\?:\s*string/)
  })

  it('后端 new_session：cwd + workspace_id: Option<String> 入参，resolve_session_cwd 统一解析', () => {
    const source = read('src-tauri/src/session/create.rs')
    expect(source).toContain('cwd: Option<String>')
    expect(source).toContain('workspace_id: Option<String>')
    expect(source).toContain('resolve_session_cwd')
  })

  it('后端 load_persisted_session：cwd + workspace_id: Option<String> 入参，resolve_session_cwd 统一解析', () => {
    const source = read('src-tauri/src/session/persist.rs')
    expect(source).toContain('cwd: Option<String>')
    expect(source).toContain('workspace_id: Option<String>')
    expect(source).toContain('resolve_session_cwd')
  })

  it('后端 cwd.rs：SessionCwd 冻结解析 + resolve_session_cwd + workspace_root_path 唯一来源', () => {
    const source = read('src-tauri/src/cwd.rs')
    expect(source).toContain('pub(crate) struct SessionCwd')
    expect(source).toContain('pub(crate) fn resolve_session_cwd')
    expect(source).toContain('state.agent_cwd()')
    expect(source).toContain('workspace_root_path')
  })

  it('后端 SessionInfo.cwd: String + workspace_id: Option<String>（runtime 槽位）', () => {
    expect(read('src-tauri/src/session/model.rs')).toContain('pub(crate) cwd: String')
    expect(read('src-tauri/src/session/model.rs')).toContain('pub(crate) workspace_id: Option<String>')
  })

  it('后端 workspace_root_for_context：冻结语义——只读 session.cwd，不回查 workspace', () => {
    const source = read('src-tauri/src/session/mod.rs')
    expect(source).toContain('workspace_root_for_context')
    expect(source).toContain('session.cwd.clone()')
    expect(source).not.toContain('workspace_root_path(&workspace_id)')
  })

  it('后端 Git 与 workspace 统一委托显式 target resolver', () => {
    const source = read('src-tauri/src/workspace_cmds.rs')
    expect(source).toContain('workspace_root_for_target')
    expect(source).toMatch(/fn git_workspace_root/)
  })
})
