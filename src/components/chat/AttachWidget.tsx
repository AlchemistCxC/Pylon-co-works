import { Paperclip } from 'lucide-react'

interface Props { onClick: () => void }

export default function AttachWidget({ onClick }: Props) {
  return (
    <button className="input-btn attach" onClick={onClick} title="Attach file" style={{ width: '100%', height: '100%', borderRadius: 6 }}>
      <Paperclip size={14} />
    </button>
  )
}
