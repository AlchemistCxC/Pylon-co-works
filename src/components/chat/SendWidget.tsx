import { ArrowUp, Square } from 'lucide-react'
import { useStore } from '../../store'

interface Props { onClick: () => void; generating?: boolean }

/**
 * sendVariant:
 *   'icon'    — 圆形背景箭头（默认）
 *   'minimal' — 无背景无边框，仅图标
 *   'square'  — 方形按钮
 *
 * generating=true 时切成"停止"按钮（方块图标），点击调用 cancel。
 */
export default function SendWidget({ onClick, generating }: Props) {
  const variant = useStore(s => s.sendVariant) || 'icon'
  const cls = variant === 'minimal' ? 'cc-send-minimal'
            : variant === 'square'  ? 'cc-send-square'
            :                         'cc-send-icon'
  return (
    <button className={`${cls}${generating ? ' cc-send-stop' : ''}`} onClick={onClick}
      title={generating ? '停止生成 (Esc)' : 'Send (Enter)'}
      style={{ width:'100%', height:'100%' }}>
      {generating ? <Square size={14} /> : <ArrowUp size={16} />}
    </button>
  )
}
