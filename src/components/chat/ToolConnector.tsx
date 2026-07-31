import { useStore } from '../../store'
import { resolveConnectorColor, type ToolConnectorStatus } from './toolPresentation'

/**
 * 连续 Tool 之间的连接线（真实 DOM 元素）。
 * - 主界面：ChatView 渲染在行间，top/height 由测量 effect 写入。
 * - 预览（.pv-app）：无测量，top/height 由 CSS 公式提供。
 * - 层叠：线 z-index:1（body 背景之上、展开截断由测量控制），head z-index:2 盖线。
 * - 颜色：跟随本行工具状态（ok/err/run 用 --tool-ok/run/err），mode none 时透明。
 */
export default function ToolConnector({ status }: { status: ToolConnectorStatus }) {
  const connectorMode = useStore(s => s.toolConnectorMode) || 'none'
  const connectorColor = useStore(s => s.toolConnectorColor) || 'rgba(0,0,0,0.12)'
  const toolOk = useStore(s => s.toolOk)
  const toolRun = useStore(s => s.toolRun)
  const toolErr = useStore(s => s.toolErr)
  const color = resolveConnectorColor(connectorMode, status, { toolOk, toolRun, toolErr }, connectorColor)
  return <div className="term-tool-connector" style={{ background: color }} />
}
