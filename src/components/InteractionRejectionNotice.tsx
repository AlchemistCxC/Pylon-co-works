import { useEffect, useState } from 'react'
import type { InteractionRejection } from '../infrastructure/acp/interactionRejectionController.ts'
import { normalizeInteractionRejection } from '../infrastructure/acp/interactionRejectionController.ts'

const NOTICE_MS = 8000

/** A compact, dismissible explanation for an interaction the host could not handle. */
export default function InteractionRejectionNotice() {
  const [notice, setNotice] = useState<InteractionRejection | null>(null)

  useEffect(() => {
    let timer: number | undefined
    const onRejected = (event: Event) => {
      const detail = normalizeInteractionRejection((event as CustomEvent<unknown>).detail)
      if (!detail) return
      setNotice(detail)
      if (timer !== undefined) window.clearTimeout(timer)
      timer = window.setTimeout(() => setNotice(null), NOTICE_MS)
    }
    window.addEventListener('pylon:interaction-rejected', onRejected)
    return () => {
      window.removeEventListener('pylon:interaction-rejected', onRejected)
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [])

  if (!notice) return null
  const target = notice.method || '交互请求'
  return (
    <div className="interaction-rejection-notice" role="alert" aria-live="assertive">
      <div className="interaction-rejection-copy">
        <strong>未支持的 Agent 交互</strong>
        <span>{notice.provider} · {target}</span>
        <small>{notice.message}</small>
      </div>
      <button type="button" aria-label="关闭交互提示" onClick={() => setNotice(null)}>×</button>
    </div>
  )
}

