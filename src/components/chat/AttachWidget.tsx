import { Paperclip } from 'lucide-react'
import { useStore } from '../../store'
import { useAgentCapabilities } from '../../infrastructure/acp/useAgentCapabilities'

interface Props { onClick: () => void }

/**
 * attachVariant:
 *   'icon'    — 圆形背景回形针（默认）
 *   'minimal' — 无背景无边框，仅图标
 *   'square'  — 方形按钮
 */
export default function AttachWidget({ onClick }: Props) {
  const variant = useStore(s => s.attachVariant) || 'icon'
  const ccScale = useStore(s => (s.ccScale || {})['attach'] ?? 100)
  // F4-C：已连接但 promptImage=false → 图片能力提示写入 title/aria，文本附件仍可用
  const capabilities = useAgentCapabilities()
  const imageUnsupported = capabilities.connected && !capabilities.promptImage
  const cls = variant === 'minimal' ? 'cc-attach-minimal'
            : variant === 'square'  ? 'cc-attach-square'
            :                         'cc-attach-icon'
  return (
    <button className={cls} onClick={onClick}
      title={imageUnsupported ? '当前 Agent 不支持图片（文本附件可用）' : 'Attach file'}
      aria-label={imageUnsupported ? '附件（当前 Agent 不支持图片）' : undefined}
      style={{ width:'100%', height:'100%', fontSize: `${ccScale}%` }}>
      <Paperclip size={14} />
    </button>
  )
}