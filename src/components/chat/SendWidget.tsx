import { ArrowUp } from 'lucide-react'
import { useStore } from '../../store'

interface Props { onClick: () => void }

/**
 * sendVariant:
 *   'icon'    — 圆形背景箭头（默认）
 *   'minimal' — 无背景无边框，仅图标
 *   'square'  — 方形按钮
 */
export default function SendWidget({ onClick }: Props) {
  const variant = useStore(s => s.sendVariant) || 'icon'
  const ccScale = useStore(s => (s.ccScale || {})['send'] ?? 100)
  const cls = variant === 'minimal' ? 'cc-send-minimal'
            : variant === 'square'  ? 'cc-send-square'
            :                         'cc-send-icon'
  return (
    <button className={cls} onClick={onClick} title="Send (Enter)"
      style={{ width:'100%', height:'100%', fontSize: `${ccScale}%` }}>
      <ArrowUp size={16} />
    </button>
  )
}
