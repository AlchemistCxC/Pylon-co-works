import type { PluginNamespaceRoot } from '../pluginData/pluginNamespace.ts'
import type { SessionCreationSnapshot } from '../../plugin-runtime/session-creation/sessionCreationTypes.ts'
import type { LegacySession } from './sessionPersistence.ts'

/**
 * identityTypes — 身份域的公共形状与纯函数（B-8a 自 identityStore 拆出；
 * identityStore 对消费面 re-export 保持既有 import 面零改动）。
 *
 * 会话显示名解析（#393 口径）是纯函数，与 store 装配解耦后可独立测试。
 */

export type { AgentEntry } from '../../contracts/agentEntry.ts'

export interface Profile {
  id: string
  name: string
  avatar?: string
  persona: string
  model: string
}

export interface Session {
  id: string
  /** ISSUE-01：会话归属 Agent（owner schema）。v2 起必需，create/update/delete 保持归属不变 */
  agentId: string
  periId?: string
  name: string
  source: string
  profileId: string
  createdAt: number
  lastActiveAt: number
  /** Timestamp of the most recent assistant reply (display semantics). */
  lastReplyAt?: number
  /** 归档时间；归档会话不显示在 Agentsheet 活动列表。 */
  archivedAt?: number
  /** 置顶：在**所属工作区内**排到最前（用户要求「置顶到当前工作区最靠前的位置」）。 */
  pinned?: boolean
  platform: string
  workdir: string
  /** CWD-03：Workspace 实体绑定（方案 C）。有值 = 绑定 Workspace（root 单一来源，
   * workdir 保持同步快照）；undefined = legacy 未绑定。workspaceId 进入 new/load wire */
  workspaceId?: string
  sessionPrompt: string
  /** @deprecated legacy/reserved：后端会话级配置链路未确定（FE-AUD-023），只读说明不编辑不发送 */
  skills: string[]
  /** @deprecated legacy/reserved：同 skills，契约确定前不提供编辑 */
  hooks: string[]
  /** M2：启用的 agent.commandSet 插件 id；缺省 = 全部已激活命令集插件（旧数据兼容）。 */
  commandSetPlugins?: string[]
  /** Agent 给的会话标题（ACP `session_info_update.title` 投影）。存储以 Agent 为准：
   *  每次收到标题都覆盖写，Agent 清空时回落到 `''`。显示见 `resolveSessionDisplayName`。 */
  autoName: string
  /** 用户是否亲手改过 `name`。置真后显示恒以 `name` 为准，Agent 后续标题只更新
   *  `autoName` 不再改显示（#393 裁决：显示优先用户、存储以 Agent 为主）。 */
  renamedByUser?: boolean
  /** 插件只能经 scope-bound API 写自己的 key。 */
  metadata?: PluginNamespaceRoot
  context?: PluginNamespaceRoot
  /** 插件会话创建贡献在本地 Session 建立时编译出的不可变、可持久化快照。 */
  creationSnapshot?: SessionCreationSnapshot
}

/**
 * 会话显示名（#393）：用户改过名 → `name`；否则 Agent 标题 `autoName` 优先；
 * 都没有才回落到 `name`（本地生成的 `session-<base36>`）。
 *
 * 显示与存储是两个口径：`autoName` 始终以 Agent 为准（每帧覆盖写），用户改名只
 * 置 `renamedByUser` 而不影响存储，Agent 也不会知道被改名（ACP 无 client→agent
 * 改标题的方法，这条不对称已裁决接受）。
 */
export function resolveSessionDisplayName(session: Pick<Session, 'name' | 'autoName' | 'renamedByUser'>): string {
  if (session.renamedByUser === true) return session.name
  return session.autoName || session.name
}

export interface Turn {
  id: string
  sessionId: string
  startedAt: number
  endedAt?: number
  metadata: PluginNamespaceRoot
  context: PluginNamespaceRoot
}

export interface UserMapping {
  id: string
  name: string
  avatar?: string
}

/**
 * ISSUE-01：会话水合结果（不含 sessions——sessions 落在 state.sessions）。
 * 非 ready 时绝不把 unresolved 静默归给 activeAgent；由恢复选择流程显式定 owner。
 */
export type SessionHydrationState =
  | { kind: 'ready' }
  | { kind: 'needs-owner-resolution'; unresolved: LegacySession[] }
  | { kind: 'corrupt'; message: string }

export type IdentityBackendStatus = 'unknown' | 'ready' | 'degraded-readonly'

export interface IdentityPersistenceState {
  profiles: IdentityBackendStatus
  sessions: IdentityBackendStatus
}

export const DEFAULT_PROFILES: Profile[] = [
  { id: 'default', name: 'Default', persona: '', model: '' },
  { id: 'local', name: 'Local', persona: '', model: '' },
]
