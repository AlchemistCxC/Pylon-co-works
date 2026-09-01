import { memo } from 'react'
import { useStore } from '../../store'
import { resolveConnectorColor, type ToolConnectorStatus } from '../../domains/tool/toolPresentation'
import { toolConnectorMotionClass } from './toolIndicatorMotion'
import type { ToolVisualState } from '../../domains/tool/status.ts'
import { useShallow } from 'zustand/react/shallow'

/**
 * 连续 Tool 之间的连接线（真实 DOM 元素）。
 * - 主界面：ChatView 渲染在行间，top/height 由测量 effect 写入。
 * - 预览（.pv-app）：无测量，top/height 由 CSS 公式提供。
 * - 层叠：线 z-index:1（body 背景之上、展开截断由测量控制），head z-index:2 盖线。
 * - 颜色和动画都继承连接线起点 Tool 的状态；mode none 时透明且无动画。
 */
function ToolConnector({ status, visualState = 'unknown' }: {
  status: ToolConnectorStatus
  visualState?: ToolVisualState
}) {
  const {
    rawConnectorMode,
    rawConnectorColor,
    toolOk,
    toolRun,
    toolErr,
    connectorStyle,
    connectorWidth,
    connectorOpacity,
  } = useStore(useShallow(s => ({
    rawConnectorMode: s.toolConnectorMode,
    rawConnectorColor: s.toolConnectorColor,
    toolOk: s.toolOk,
    toolRun: s.toolRun,
    toolErr: s.toolErr,
    connectorStyle: s.toolConnectorStyle,
    connectorWidth: s.toolConnectorWidth,
    connectorOpacity: s.toolConnectorOpacity,
  })))
  const connectorMode = rawConnectorMode || 'none'
  const connectorColor = rawConnectorColor || 'rgba(0,0,0,0.12)'
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

// 连接线是 props + store 订阅的纯展示组件：ChatView 重渲染时跳过，主题变化仍即时生效
export default memo(ToolConnector)
