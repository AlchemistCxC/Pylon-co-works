/**
 * streamChannel — pylon:update/done/error 的 per-session IPC Channel 消费端
 * （Channel 化重构 B1；后端契约见 src-tauri/src/dispatcher/mod.rs A3 与
 * .hermes/plans/2026-08-23_pylon-update-channel-refactor.md）。
 *
 * 帧信封（四事件同构）：{ event: 'pylon:update'|'pylon:done'|'pylon:error'|'pylon:user', payload }
 * - update 帧：payload = 原 pylon:update 载荷（source 注入 + canonicalEvent 可选）
 * - done/error 终帧：payload = 完整终态载荷（source/code/error/data + canonicalEvent 可选）
 * - user 帧：payload = { source, content, injectActivated?, canonicalEvent? }
 *
 * 单源消费由后端保证（已注册 source 跳过广播），本模块不做幂等去重。
 * 测试环境（非 Tauri / fake 总线）自动降级为 no-op 注册。
 */
import { Channel } from '@tauri-apps/api/core'
import { IS_TAURI } from '../../infrastructure/tauri/env'

export type StreamFrameEvent = 'pylon:update' | 'pylon:done' | 'pylon:error' | 'pylon:user'

export interface StreamFrame {
  event: StreamFrameEvent
  payload: unknown
}

/** 帧消费者：canonicalEventFeed 按 event 字段统一处理（P52 D2）。 */
export type StreamFrameHandler = (frame: StreamFrame) => void

interface ActiveStream {
  channel: Channel<StreamFrame>
  handler: StreamFrameHandler
}

/** source → 在途流。同一 source 重复发送以新换旧（对齐后端注册表语义）。 */
const activeStreams = new Map<string, ActiveStream>()

/**
 * 发送消息时建立 source 的流式通道并把 on_update 随 invoke 传出。
 * 返回值直接作为 send_message_streaming 的 on_update 参数（序列化为 __CHANNEL__:id）。
 * 非 Tauri 环境返回 undefined（调用方走旧命令路径）。
 */
export function openStreamChannel(source: string, handler: StreamFrameHandler): Channel<StreamFrame> | undefined {
  if (!IS_TAURI) return undefined
  // 以新换旧：旧通道对象随 GC 废弃，后端 register_update_channel 同样覆盖。
  closeStreamChannel(source)
  const channel = new Channel<StreamFrame>(frame => {
    activeStreams.get(source)?.handler(frame)
  })
  activeStreams.set(source, { channel, handler })
  return channel
}

/** 终帧/异常收尾：移除注册。与 openStreamChannel 配对；重复调用安全。 */
export function closeStreamChannel(source: string): void {
  activeStreams.delete(source)
}

/** 测试/诊断：查询在途流。 */
export function hasActiveStream(source: string): boolean {
  return activeStreams.has(source)
}
