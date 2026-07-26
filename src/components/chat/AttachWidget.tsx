import { Paperclip } from 'lucide-react'
import { useStore } from '../../store'

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
  const cls = variant === 'minimal' ? 'cc-attach-minimal'
            : variant === 'square'  ? 'cc-attach-square'
            :                         'cc-attach-icon'
  return (
    <button className={cls} onClick={onClick} title="Attach file"
      style={{ width:'100%', height:'100%', fontSize: `${ccScale}%` }}>
      <Paperclip size={14} />
    </button>
  )
}