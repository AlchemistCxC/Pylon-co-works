/**
 * 事件投影契约（施工方案书 v3 §M7）：event.projector 扩展点。
 *
 * 契约层不 import domains；运行时投影经 domains/events/messageProjection（legacy 查询面）。
 * 插件贡献的 projector 在 activate/deactivate 时同步进 legacy registry。
 */

/** event.projector 扩展点 id。 */
export const EVENT_PROJECTOR_POINT = 'event.projector'

/** event.projector 贡献 impl：canonical 事件流 → 前端消息数组。 */
export interface EventProjector {
  readonly projectorId: string
  /** 空数组 = 兜底投影器（处理任意事件流）。 */
  readonly eventTypes: readonly string[]
  project(events: readonly unknown[]): unknown[]
}
