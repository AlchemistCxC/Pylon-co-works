import { useStore } from '../../store'
import { resolveConnectorColor, type ToolConnectorStatus } from './toolPresentation'
import { toolConnectorMotionClass } from './toolIndicatorMotion'
import type { ToolVisualState } from './toolStatus'

/**
 * 连续 Tool 之间的连接线（真实 DOM 元素）。
 * - 主界面：ChatView 渲染在行间，top/height 由测量 effect 写入。
 * - 预览（.pv-app）：无测量，top/height 由 CSS 公式提供。
 * - 层叠：线 z-index:1（body 背景之上、展开截断由测量控制），head z-index:2 盖线。
 * - 颜色和动画都继承连接线起点 Tool 的状态；mode none 时透明且无动画。
 */
export default function ToolConnector({ status, visualState = 'unknown' }: {
  status: ToolConnectorStatus
  visualState?: ToolVisualState
}) {
  const connectorMode = useStore(s => s.toolConnectorMode) || 'none'
  const connectorColor = useStore(s => s.toolConnectorColor) || 'rgba(0,0,0,0.12)'
  const toolOk = useStore(s => s.toolOk)
  const toolRun = useStore(s => s.toolRun)
  const toolErr = useStore(s => s.toolErr)
  const connectorStyle = useStore(s => s.toolConnectorStyle)
  const connectorWidth = useStore(s => s.toolConnectorWidth)
  const connectorOpacity = useStore(s => s.toolConnectorOpacity)
  const color = resolveConnectorColor(connectorMode, status, { toolOk, toolRun, toolErr }, connectorColor)
  const style: React.CSSProperties = {
    background: color,
    ['--tool-connector-color' as never]: color,
    ['--tool-connector-width' as never]: `${Math.max(1, Math.min(6, connectorWidth || 2))}px`,
    ['--tool-connector-opacity' as never]: Math.max(0.1, Math.min(1, connectorOpacity ?? 1)),
  }
  return (
    <div
      className={`term-tool-connector term-tool-connector-style--${connectorStyle || 'solid'} ${toolConnectorMotionClass(visualState)}`}
      data-tool-state={visualState}
      style={style}
    />
  )
}
