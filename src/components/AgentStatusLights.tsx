import { agentLightDisplay } from '../domains/agent/statusLight'
import type { CSSProperties } from 'react'

/**
 * AgentStatusLights — agent 状态三灯（视觉调整：左上角品牌区替代 Pylon 标识）。
 *
 * 规则：
 * - ok：三灯全亮，辉光从左到右传播（各灯周期同、启动时间递增）
 * - warn：黄灯辉光常亮，其余两灯灰
 * - error：三灯全红，统一周期辉光
 * - off：全灰无辉光
 */
export default function AgentStatusLights({ status, size = 10 }: { status: string; size?: number }) {
  const display = agentLightDisplay(status)
  return (
    <div className="agent-status-lights" data-mode={display.mode} aria-label="Agent 状态" style={{ gap: Math.max(2, size / 3) }}>
      {display.lights.map((light, index) => (
        <span
          key={index}
          className={`agent-status-light agent-light-${light}`}
          style={{ width: size, height: size, '--light-i': index } as CSSProperties}
        />
      ))}
    </div>
  )
}
