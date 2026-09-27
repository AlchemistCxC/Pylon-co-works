import { For } from 'solid-js'
import { agentLightDisplay } from '../domains/agent/statusLight'

/**
 * AgentStatusLights — agent 状态三灯（Solid 实体，#279 第 3 梯队；与 React 版逐字段
 * 同构：类名是首方样式消费契约）。
 *
 * 规则：
 * - ok：三灯全亮，辉光从左到右传播（各灯周期同、启动时间递增）
 * - warn：黄灯辉光常亮，其余两灯灰
 * - error：三灯全红，统一周期辉光
 * - off：全灰无辉光
 */
export default function AgentStatusLights(props: { status: string; size?: number }) {
  const display = () => agentLightDisplay(props.status)
  const size = () => props.size ?? 10
  return (
    <div class="agent-status-lights" data-mode={display().mode} aria-label="Agent 状态" style={{ gap: `${Math.max(2, size() / 3)}px` }}>
      <For each={display().lights}>{(light, index) => (
        <span
          class={`agent-status-light agent-light-${light}`}
          style={{ width: `${size()}px`, height: `${size()}px`, '--light-i': String(index()) }}
        />
      )}</For>
    </div>
  )
}
