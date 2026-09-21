import { Show } from 'solid-js'
import { SolidRendererSlotHost } from './chat/RendererSlotHost.solid.tsx'
import type { SolidWorkbenchContextValue } from './SolidWorkbenchContext.solid.tsx'

/** Shared dispatch seam between builtin fallbacks and renderer-plugin slots
 * (used by the workbench content, document surface, activity list and row
 * renderers). */
export function WorkbenchContentSlot(props: {
  nodeId: string
  kind: string
  payload: unknown
  streaming?: boolean
  context: SolidWorkbenchContextValue
  fallback: import('solid-js').JSX.Element
}) {
  const candidates = () => (props.context.activation?.slots.get(props.kind) ?? [])
    .filter(entry => entry.value.kinds.includes(props.kind))
  const hasCandidate = () => {
    if (candidates().length > 0) return true
    const activation = props.context.activation
    if (!activation) return false
    const visited = new Set<string>([props.kind])
    let fallbackKind = activation.kinds.get(props.kind)?.value.fallbackKind
    while (fallbackKind && !visited.has(fallbackKind)) {
      visited.add(fallbackKind)
      if ((activation.slots.get(fallbackKind) ?? []).some(entry => entry.value.kinds.includes(fallbackKind!))) return true
      fallbackKind = activation.kinds.get(fallbackKind)?.value.fallbackKind
    }
    return false
  }
  return <Show when={hasCandidate()} fallback={props.fallback}>
    <SolidRendererSlotHost
      candidates={candidates()}
      node={{
        nodeId: props.nodeId,
        kind: props.kind,
        revision: props.context.runtimeSnapshot().revision,
        payload: props.payload,
        ...(props.streaming === true ? { streaming: true } : {}),
      }}
      context={props.context}
      fallback={props.fallback}
    />
  </Show>
}
