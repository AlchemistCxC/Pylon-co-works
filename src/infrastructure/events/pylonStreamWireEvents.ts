/**
 * pylon:* 流式终帧 wire 事件名单一来源（Rust runtime emit → 前端 listen）。
 *
 * 四事件同构帧信封：`update`（增量）/ `user`（用户输入回显）/ `done`、`error`
 * （终帧，对应后端 finalize_response、publish_prompt_failure 两条收尾路径）。
 * 类型 union 与运行时判定一律从本文件派生，勿散写字面量。
 */
export const PYLON_STREAM_WIRE_EVENTS = {
  update: 'pylon:update',
  user: 'pylon:user',
  done: 'pylon:done',
  error: 'pylon:error',
} as const

export type PylonStreamWireEvent = (typeof PYLON_STREAM_WIRE_EVENTS)[keyof typeof PYLON_STREAM_WIRE_EVENTS]
