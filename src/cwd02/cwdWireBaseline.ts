/**
 * CWD-02/03：ACP cwd wire 取证（方案书任务表 CWD-02，§5.16——new/load wire 现状登记；
 * CWD-03 迁移后翻红基线全部翻转）。
 *
 * 目的：以真实代码为据登记 ACP 会话创建/恢复路径（new_session / load_persisted_session）上
 * cwd 与 workspace 绑定的完整流向，为 CWD-03（workspace_id 入 wire + Binding invalidate/reload）
 * 提供验收基准。只读取证，不修改任何 wire 行为（CWD-01 已拍板方案 C：独立 Workspace 实体，
 * Session 绑定 Workspace；wire 迁移属 CWD-03，已完成）。
 *
 * 已证实 wire 流向（CWD-02 取证 → CWD-03 迁移完成）：
 *   前端 Session.workdir（identityStore.ts:40，Session 扁平字符串字段，兼容快照保留）
 *     + Session.workspaceId（identityStore.ts:43，CWD-03 绑定维）
 *     → 前端 wire payload：NewSessionPayload.cwd/workspaceId、LoadPersistedSessionPayload.cwd/workspaceId
 *       （sessionClient.ts:17,19 / :30,32——均可选 string，调用方组装）
 *     → 后端 new_session（create.rs:191 `workspace_id: Option<String>`，216-217 resolve_session_cwd；
 *       未绑定回退 agent_cwd()）
 *     → 后端 load_persisted_session（persist.rs:19 `workspace_id: Option<String>`，29-30
 *       resolve_session_cwd；未绑定回退 agent_cwd()）
 *     → workspace 解析（workspaces.rs:57 resolve_session_cwd → 注册表 root_path 为唯一 root 来源；
 *       workspace_root_path 查询 :82；缺失结构化报错不静默回退）
 *     → RuntimeSession（model.rs:12 cwd 兼容快照 + :31 workspace_id 绑定维）
 *     → workspace_root_for_context（mod.rs:335，:367 workspace 绑定优先、session.cwd 兼容回退）
 *     → workspace 命令（workspace_cmds.rs:14-88 全部经 workspace_root_for_source 解析 root）与
 *       git_workspace_root（workspace_cmds.rs:100-110 委托同链）。
 *   CWD-03 后：cwd 单一来源迁移为 Workspace 实体 root_path（session.workspace_id → Workspace 表
 *   → root_path），WORKSPACE_ENTITY_BINDING_IN_PLACE / WORKSPACE_ID_IN_EVENT_OWNER 翻转为 true。
 *
 * 纪律（方案书 §2 阶段 M0 同模式，与 CSS-01/OBS-06 取证卡一致）：只读取证；不修改业务语义；
 * 结构性常量（CWD_WIRE_CARRIES_CWD / WORKSPACE_ENTITY_BINDING_IN_PLACE /
 * WORKSPACE_ID_IN_EVENT_OWNER）为 CWD-03 的翻红基线——本卡已全部翻转为 true。
 */

/** 结构性常量：ACP cwd wire 关键证据（代码级登记，file:line 精确可追溯）。 */
export const CWD_WIRE_EVIDENCE = {
  frontend: {
    sessionWorkdir: {
      file: 'src/identityStore.ts:40',
      shape: 'Session.workdir: string',
      note: '前端 Session 扁平字符串字段——CWD-03 迁移为 workspaceId 绑定后作为兼容快照保留。',
    },
    sessionWorkspaceBinding: {
      file: 'src/identityStore.ts:43',
      shape: 'Session.workspaceId?: string',
      note: '前端 Session 绑定 Workspace 实体 id（CWD-03 新增；undefined = legacy 未绑定）。',
    },
    newSessionPayload: {
      file: 'src/infrastructure/acp/sessionClient.ts:17,19',
      shape: 'NewSessionPayload.cwd?: string + workspaceId?: string',
      note: 'new_session wire 携带 cwd（兼容）与 workspaceId（CWD-03 绑定维）；调用方组装。',
    },
    loadPersistedPayload: {
      file: 'src/infrastructure/acp/sessionClient.ts:30,32',
      shape: 'LoadPersistedSessionPayload.cwd?: string + workspaceId?: string',
      note: 'load_persisted_session wire 携带 cwd（兼容）与 workspaceId（CWD-03 绑定维）。',
    },
    eventOwnerWorkspaceId: {
      file: 'src/domains/events/eventSchema.ts:25',
      shape: 'CanonicalEventOwner.workspaceId?: string',
      note: '事件 owner 块携带绑定维（不参与 owner key）——WORKSPACE_ID_IN_EVENT_OWNER 证据。',
    },
  },
  backend: {
    newSession: {
      file: 'src-tauri/src/session/create.rs:191,216-217',
      shape: 'workspace_id: Option<String> → resolve_session_cwd(cwd, workspace_id)',
      note: 'new_session 后端入口：workspace 绑定优先解析 root，未绑定回退 active agent cwd。',
    },
    loadPersisted: {
      file: 'src-tauri/src/session/persist.rs:19,29-30',
      shape: 'workspace_id: Option<String> → resolve_session_cwd(cwd, workspace_id)',
      note: 'load_persisted_session 后端入口：workspace 绑定优先解析 root，未绑定回退 active agent cwd。',
    },
    workspaceResolve: {
      file: 'src-tauri/src/workspaces.rs:57,82',
      shape: 'resolve_session_cwd → Workspace 注册表 root_path（缺失结构化报错）',
      note: 'CWD-03 唯一 root 来源：workspace_id → 注册表 root_path；Workspace 实体定义见 :28。',
    },
    runtimeSessionCwd: {
      file: 'src-tauri/src/session/model.rs:12,31',
      shape: 'SessionInfo.cwd: String（兼容快照）+ workspace_id: Option<String>（绑定维）',
      note: '运行时会话槽位持有 cwd 快照与 workspace 绑定——workspace/git 命令 root 解析来源。',
    },
    workspaceRootResolution: {
      file: 'src-tauri/src/session/mod.rs:335,367',
      shape: 'workspace_root_for_context → workspace_root_path（绑定优先）→ session.cwd（回退）',
      note: 'workspace 绑定优先于 cwd 快照；未绑定走兼容分支（CWD-03 决策 1 语义嫁接）。',
    },
    gitWorkspaceRoot: {
      file: 'src-tauri/src/workspace_cmds.rs:100-110',
      shape: 'git_workspace_root → workspace_root_for_source',
      note: 'Git 命令 cwd 与 workspace 命令共用同一解析链（四类 cwd 一致性的 Git 侧证据）。',
    },
    workspaceCommands: {
      file: 'src-tauri/src/workspace_cmds.rs:14-88',
      shape: 'list/read/write/search 全部经 workspace_root_for_source 解析 root',
      note: 'workspace 命令 cwd 单一来源——无独立于 session.cwd/workspace root 的路径分支。',
    },
  },
} as const

/** 结构性常量：new/load wire 是否携带 cwd（当前 true——plain string 形态 + CWD-03 workspace 绑定维）。 */
export const CWD_WIRE_CARRIES_CWD = true
/** 结构性常量：Workspace 实体绑定是否就位（CWD-03 已翻转——session 携 workspaceId 绑定，注册表解析 root）。 */
export const WORKSPACE_ENTITY_BINDING_IN_PLACE = true
/** 结构性常量：事件 owner 块是否携带 workspaceId（CWD-03 已翻转——EVT schema 扩绑定维）。 */
export const WORKSPACE_ID_IN_EVENT_OWNER = true

// ============================================================================
// cwd wire contract（取证登记：new/load 全链流向）
// ============================================================================

export interface CwdWireNode {
  /** 链路段名称（frontend / newSession / loadPersisted / runtime / workspaceRoot / gitRoot / commands）。 */
  segment: string
  /** 证据位置（CWD_WIRE_EVIDENCE 对应 file）。 */
  file: string
  /** 该段 cwd 的形态（payload/参数/存储字段）。 */
  shape: string
}

/** CWD-02/03：new/load wire 的 cwd + workspace 绑定流向契约——以证据登记为真值，按流向顺序输出各段形态。 */
export function cwdWireContract(): CwdWireNode[] {
  const ev = CWD_WIRE_EVIDENCE
  return [
    { segment: 'frontend-session', file: ev.frontend.sessionWorkdir.file, shape: ev.frontend.sessionWorkdir.shape },
    { segment: 'frontend-workspace-binding', file: ev.frontend.sessionWorkspaceBinding.file, shape: ev.frontend.sessionWorkspaceBinding.shape },
    { segment: 'new-session-payload', file: ev.frontend.newSessionPayload.file, shape: ev.frontend.newSessionPayload.shape },
    { segment: 'load-persisted-payload', file: ev.frontend.loadPersistedPayload.file, shape: ev.frontend.loadPersistedPayload.shape },
    { segment: 'backend-new-session', file: ev.backend.newSession.file, shape: ev.backend.newSession.shape },
    { segment: 'backend-load-persisted', file: ev.backend.loadPersisted.file, shape: ev.backend.loadPersisted.shape },
    { segment: 'backend-workspace-resolve', file: ev.backend.workspaceResolve.file, shape: ev.backend.workspaceResolve.shape },
    { segment: 'runtime-session', file: ev.backend.runtimeSessionCwd.file, shape: ev.backend.runtimeSessionCwd.shape },
    { segment: 'workspace-root', file: ev.backend.workspaceRootResolution.file, shape: ev.backend.workspaceRootResolution.shape },
    { segment: 'git-root', file: ev.backend.gitWorkspaceRoot.file, shape: ev.backend.gitWorkspaceRoot.shape },
    { segment: 'workspace-commands', file: ev.backend.workspaceCommands.file, shape: ev.backend.workspaceCommands.shape },
  ]
}

// ============================================================================
// 取证工件
// ============================================================================

export interface CwdWireBaselineArtifact {
  schemaVersion: 1
  wire: CwdWireNode[]
  constants: {
    CWD_WIRE_CARRIES_CWD: boolean
    WORKSPACE_ENTITY_BINDING_IN_PLACE: boolean
    WORKSPACE_ID_IN_EVENT_OWNER: boolean
  }
}

/** CWD-02/03：取证工件组装（schemaVersion 1）——new/load cwd wire + workspace 绑定现状快照。 */
export function buildCwdWireBaselineArtifact(): CwdWireBaselineArtifact {
  return {
    schemaVersion: 1,
    wire: cwdWireContract(),
    constants: {
      CWD_WIRE_CARRIES_CWD,
      WORKSPACE_ENTITY_BINDING_IN_PLACE,
      WORKSPACE_ID_IN_EVENT_OWNER,
    },
  }
}
