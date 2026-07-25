import { ArrowUp } from 'lucide-react'

interface Props { onClick: () => void }

export default function SendWidget({ onClick }: Props) {
  return (
    <button className="input-btn send" onClick={onClick} title="Send (Enter)" style={{ width: '100%', height: '100%', borderRadius: 6 }}>
      <ArrowUp size={16} />
    </button>
  )
}
