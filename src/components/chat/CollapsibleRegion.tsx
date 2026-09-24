import type { ReactNode } from 'react'

/**
 * Keeps collapsible content mounted so Presentation styles can animate both
 * opening and closing. The host owns accessibility and lifecycle; individual
 * message surfaces only provide their body.
 */
export default function CollapsibleRegion({ open, id, children, className = '' }: {
  open: boolean
  id?: string
  children: ReactNode
  className?: string
}) {
  return (
    <div
      className={`term-collapse${className ? ` ${className}` : ''}`}
      data-open={open ? 'true' : 'false'}
      aria-hidden={!open}
    >
      <div className="term-collapse-content" id={id}>{children}</div>
    </div>
  )
}
