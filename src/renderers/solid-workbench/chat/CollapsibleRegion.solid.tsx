import type { JSX } from 'solid-js'

/** Solid renderer counterpart of the host collapse seam. */
export function SolidCollapsibleRegion(props: {
  open: boolean
  id?: string
  class?: string
  children: JSX.Element
}) {
  return (
    <div
      class={`term-collapse${props.class ? ` ${props.class}` : ''}`}
      data-open={props.open ? 'true' : 'false'}
      aria-hidden={!props.open}
    >
      <div class="term-collapse-content" id={props.id}>{props.children}</div>
    </div>
  )
}
