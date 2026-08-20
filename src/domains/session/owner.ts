/**
 * OWNER-01：AgentSessionOwner contract（方案书 §5.8）。
 *
 * OwnerKey = profileId + agentId + localSessionId（localSessionId 即会话 source）。
 * BindingKey = OwnerKey + remoteSessionId(periId) + clientGeneration。
 *
 * A 版契约（与后端 src-tauri/session/owner.rs 一一对应）：
 * - `agentId` + `source` 必填（source 只在单个 Agent runtime 内唯一）；
 * - `profileId` 为声明维——后端无权威 profile 注册表（AgentDef.hermes_profile 是
 *   per-agent Hermes 环境注入、Profile.id 是 UI persona 配置、gateway binding.profile_id
 *   仅展示），A 版只携带不校验，校验语义待 profile 注册表建立后决策；
 * - owner key 字符串化**禁止** `${agentId}:${source}` 拼接（source 可含冒号），
 *   统一 JSON 数组序列化（与 AgentContextKey 同纪律）。
 *
 * 用法：命令层携带 owner 意图（OWNER-02 起显式 agentId 路由）；本文件只定义契约
 * 与 key 纯函数，不触达 store/transport。
 */

/** 会话 owner 契约：owner 意图的完整表达（AgentContext 的超集）。 */
export interface SessionOwner {
  agentId: string
  source: string
  profileId?: string
}

/** SQLite/canonical durable identity. All fields are required; remote session
 * ids are bindings and must never participate in this identity. */
export interface DurableSessionOwner {
  profileId: string
  agentId: string
  localSessionId: string
}

export function toDurableSessionOwnerKey(owner: DurableSessionOwner): string {
  return JSON.stringify([owner.profileId, owner.agentId, owner.localSessionId])
}

/** owner key 序列化（禁止冒号拼接——source 可能含冒号，JSON 数组保证无歧义）。 */
export function toSessionOwnerKey(owner: SessionOwner): string {
  return JSON.stringify(
    owner.profileId
      ? [owner.profileId, owner.agentId, owner.source]
      : [owner.agentId, owner.source],
  )
}
