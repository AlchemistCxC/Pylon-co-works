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

/**
 * 三灯辉光展示模型（视觉调整）：
 * - ok（连接良好）：三灯全亮，辉光从左到右传播（各灯周期同、启动时间递增）
 * - warn（连接中）：黄灯辉光常亮，其余两灯灰
 * - error（断开/崩溃）：三灯全红，统一周期辉光
 * - off（未知/闲置）：全灰无辉光
 */
export type AgentLightMode = 'cascade' | 'sync' | 'steady' | 'none'

export interface AgentLightDisplay {
  lights: AgentLight[]
  mode: AgentLightMode
}

export function agentLightDisplay(status: string): AgentLightDisplay {
  const light = agentStatusLight(status)
  if (light === 'ok') return { lights: ['ok', 'warn', 'error'], mode: 'cascade' }
  if (light === 'warn') return { lights: ['warn', 'off', 'off'], mode: 'steady' }
  if (light === 'error') return { lights: ['error', 'error', 'error'], mode: 'sync' }
  return { lights: ['off', 'off', 'off'], mode: 'none' }
}
