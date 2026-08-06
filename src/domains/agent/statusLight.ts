/**
 * statusLight — agent 状态 → 三色灯（W2-11，S8/F2-C）。
 *
 * 状态灯是异常可见装置（不是装饰）：绿呼吸=connected、黄常亮=connecting/reconnecting、
 * 红常亮=crashed/disconnected/error，其余（inactive/未知）全灰。纯函数可单测——
 * 六 status → 三灯状态由守卫锁定。
 */

export type AgentLight = 'ok' | 'warn' | 'error' | 'off'

export function agentStatusLight(status: string): AgentLight {
  switch (status) {
    case 'connected':
      return 'ok'
    case 'connecting':
    case 'reconnecting':
      return 'warn'
    case 'crashed':
    case 'disconnected':
    case 'error':
      return 'error'
    default:
      return 'off'
  }
}
