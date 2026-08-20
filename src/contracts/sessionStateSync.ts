/**
 * 会话状态同步契约（施工方案书 v3 §M7）：sessionState.sync 扩展点。
 *
 * 契约层不 import domains；运行时同步逻辑经 domains/sessionState/sessionStateSync
 * （legacy 查询面）。插件贡献的 provider 在 activate/deactivate 时同步进 legacy registry。
 */

/** sessionState.sync 扩展点 id。 */
export const SESSION_STATE_SYNC_POINT = 'sessionState.sync'

/** 会话状态同步 provider：把 wire 响应/更新写入宿主 runtime store。 */
export interface SessionStateSyncProvider {
  readonly providerId: string
  /** new_session / load_persisted_session 响应：mode / usage / configOptions。 */
  applyResponse?(context: unknown, response: unknown): void
  /** live session_update：usage / session_info / commands / config_option。 */
  applyUpdate?(context: unknown, update: { kind: string; payload: unknown }): void
}
