import { Show, createEffect, createSignal, onCleanup, onMount, type JSX } from 'solid-js'
import type { RenderCommandPort, RenderNodeSnapshot, RenderSurface } from '../../../contracts/messageRenderer.ts'
import { executeRendererSemanticCommand, isRenderSemanticCommand } from '../../../host/renderer-suite/rendererSemanticCommand.ts'
import type { RendererSlotContribution } from '../../../plugin-runtime/renderers/rendererSuiteTypes.ts'
import type { RegistryEntry } from '../../../plugin-runtime/registry/types.ts'
import type { SolidWorkbenchContextValue } from '../SolidWorkbenchContext.solid.tsx'
import { normalizeWorkbenchMountInput } from '../workbenchContracts.ts'

export function SolidRendererSlotHost(props: {
  candidates: readonly RegistryEntry<RendererSlotContribution>[]
  node: RenderNodeSnapshot
  context: SolidWorkbenchContextValue
  fallback: JSX.Element
}) {
  let container: HTMLDivElement | undefined
  let surface: RenderSurface | undefined
  let handle: unknown
  let surfaceMounted = false
  let currentIndex = -1
  let currentEntry: RegistryEntry<RendererSlotContribution> | undefined
  let currentKind = props.node.kind
  let recovering = false
  let unsubscribeError = () => {}
  let unsubscribeAction = () => {}
  const [mounted, setMounted] = createSignal(false)

  const executeSemanticCommand: RenderCommandPort['execute'] = async command => {
    const host = props.context.hostPort
    if (!host) return
    await executeRendererSemanticCommand({
      command, host, mountInput: normalizeWorkbenchMountInput(props.context.input()),
      slotId: currentEntry?.value.id, kind: currentKind,
    })
  }

  const commands: RenderCommandPort = {
    execute: executeSemanticCommand,
    canExecute: commandType => {
      const capabilities = props.context.hostPort?.capabilities
      if (!capabilities) return false
      switch (commandType) {
        case 'clipboard.write': return capabilities.has('clipboardWrite')
        case 'interaction.respond': return capabilities.has('interactionResponse')
        case 'tool.action': return capabilities.has('toolAction')
        case 'resource.open': return capabilities.has('resourceOpen')
        case 'resource.reveal': return capabilities.has('resourceReveal')
        case 'message.retry': return capabilities.has('retry')
        case 'session.recover': return capabilities.has('recovery')
        default: return false
      }
    },
  }

  const candidateSequence = () => {
    const result: Array<{ entry: RegistryEntry<RendererSlotContribution>; kind: string }> = []
    const seen = new Set<string>()
    const append = (entries: readonly RegistryEntry<RendererSlotContribution>[], kind: string) => {
      for (const entry of entries) {
        const key = `${entry.ownerRuntimeInstanceId}\u0000${entry.contributionId}`
        if (seen.has(key)) continue
        seen.add(key)
        result.push({ entry, kind })
      }
    }
    append(props.candidates, props.node.kind)
    const activation = props.context.activation
    let fallbackKind = activation?.kinds.get(props.node.kind)?.value.fallbackKind
    const visited = new Set<string>([props.node.kind])
    while (activation && fallbackKind && !visited.has(fallbackKind)) {
      const kind = fallbackKind
      visited.add(kind)
      append((activation.slots.get(kind) ?? []).filter(entry => entry.value.kinds.includes(kind)), kind)
      fallbackKind = activation.kinds.get(kind)?.value.fallbackKind
    }
    if (activation && !visited.has('content.unknown')) append(
      (activation.slots.get('content.unknown') ?? []).filter(entry => entry.value.kinds.includes('content.unknown')),
      'content.unknown',
    )
    return result
  }

  const report = (code: string, error: unknown, phase: 'mount' | 'update' | 'destroy', entry = currentEntry) => {
    props.context.hostPort?.diagnostics.report({
      code, message: error instanceof Error ? error.message : String(error),
      phase, recoverability: 'none', slotId: entry?.value.id, kind: currentKind,
    })
  }

  const destroyCurrent = () => {
    const mountedSurface = surface
    const mountedHandle = handle
    const mountedEntry = currentEntry
    const wasMounted = surfaceMounted
    unsubscribeError(); unsubscribeError = () => {}
    unsubscribeAction(); unsubscribeAction = () => {}
    surface = undefined; handle = undefined; surfaceMounted = false; currentEntry = undefined
    if (mountedSurface && wasMounted) {
      try { mountedSurface.destroy(mountedHandle) } catch (error) {
        report('renderer.slot.destroy.failed', error, 'destroy', mountedEntry)
      }
    }
    container?.replaceChildren()
    setMounted(false)
  }

  const mountFrom = (startIndex: number): boolean => {
    if (!container) return false
    const candidates = candidateSequence()
    for (let index = startIndex; index < candidates.length; index += 1) {
      const { entry, kind } = candidates[index]
      const node = kind === props.node.kind ? props.node : { ...props.node, kind }
      try {
        if (!entry.value.canRender(node)) continue
        const candidate = entry.value.createSurface(node)
        const candidateHandle = candidate.mount(container, node, { ...props.context.appearanceSnapshot() }, commands)
        currentIndex = index
        currentEntry = entry
        currentKind = kind
        surface = candidate
        handle = candidateHandle
        surfaceMounted = true
        container.dataset.rendererSlotId = entry.value.id
        const candidateUnsubscribeError = candidate.on('error', error => recover(error, 'update'))
        if (surface !== candidate) {
          candidateUnsubscribeError()
          return surfaceMounted
        }
        unsubscribeError = candidateUnsubscribeError
        const candidateUnsubscribeAction = candidate.on('request-action', action => {
          if (isRenderSemanticCommand(action)) void executeSemanticCommand(action)
          else props.context.hostPort?.diagnostics.report({
            code: 'renderer_action_invalid', message: 'Renderer request-action 不是 semantic command',
            phase: 'action', recoverability: 'none', slotId: entry.value.id, kind,
          })
        })
        if (surface !== candidate) {
          candidateUnsubscribeAction()
          return surfaceMounted
        }
        unsubscribeAction = candidateUnsubscribeAction
        setMounted(true)
        return true
      } catch (error) {
        currentKind = kind
        report('renderer.slot.mount.failed', error, 'mount', entry)
        container.replaceChildren()
      }
    }
    currentIndex = candidates.length
    return false
  }

  const recover = (error: unknown, phase: 'mount' | 'update') => {
    if (recovering) return
    recovering = true
    const failed = currentEntry
    const nextIndex = currentIndex + 1
    report(phase === 'mount' ? 'renderer.slot.mount.failed' : 'renderer.slot.runtime.failed', error, phase, failed)
    destroyCurrent()
    const recovered = mountFrom(nextIndex)
    recovering = false
    if (!recovered) props.context.reportRendererError?.(error)
  }

  onMount(() => {
    if (!mountFrom(0)) props.context.reportRendererError?.(new Error(`Renderer Slot 候选耗尽：${props.node.kind}`))
  })

  createEffect(() => {
    const node = props.node
    const appearance = props.context.appearanceSnapshot()
    if (!surface || !surfaceMounted) return
    const resolvedNode = currentKind === node.kind ? node : { ...node, kind: currentKind }
    try { surface.update(handle, resolvedNode, { ...appearance }) } catch (error) { recover(error, 'update') }
  })

  onCleanup(() => {
    destroyCurrent()
  })

  return <>
    <div ref={container} class="solid-renderer-slot-host" hidden={!mounted()} />
    <Show when={!mounted()}>{props.fallback}</Show>
  </>
}
