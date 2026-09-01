import { For, createEffect, createSignal, onCleanup, onMount, untrack } from 'solid-js'
import { resolveConnectorColor, type ToolConnectorStatus } from '../../../domains/tool/toolPresentation.ts'
import { toolConnectorMotionClass } from '../../../components/chat/toolIndicatorMotion.ts'
import type { ToolVisualState } from '../../../domains/tool/status.ts'
import type { WorkbenchAppearanceSnapshot } from '../../../domains/workbench/appearance.ts'
import type {
  ToolConnectorInvalidationReason,
  ToolConnectorLayoutPort,
} from '../../../domains/workbench/toolConnectorLayoutPort.ts'
import { measureToolConnector } from './domToolConnectorMeasurement.ts'

export type ToolConnectorAppearance = Pick<WorkbenchAppearanceSnapshot,
  'toolConnectorMode' | 'toolConnectorColor' | 'toolConnectorStyle' | 'toolConnectorWidth' | 'toolConnectorOpacity'>

export interface SolidToolConnectorProps {
  connectorKey: string
  fromMessageId: string
  toMessageId: string
  status: ToolConnectorStatus
  visualState?: ToolVisualState
  appearance: ToolConnectorAppearance
  layoutPort: ToolConnectorLayoutPort
  colors?: { toolOk?: string; toolRun?: string; toolErr?: string }
  /** Explicit coordinate root supplied by the shared overlay. */
  coordinateRoot?: () => HTMLElement | undefined
}

export interface SolidToolConnectorEdge {
  key: string
  fromMessageId: string
  toMessageId: string
  status: ToolConnectorStatus
  visualState?: ToolVisualState
  appearance: ToolConnectorAppearance
}

export interface SolidToolConnectorLayerProps {
  edges: readonly SolidToolConnectorEdge[]
  layoutPort: ToolConnectorLayoutPort
}

export function SolidToolConnector(props: SolidToolConnectorProps) {
  let connector: HTMLDivElement | undefined
  let observer: ResizeObserver | undefined
  const state = () => props.visualState ?? 'unknown'
  const connectorMode = () => props.appearance.toolConnectorMode || 'fixed'
  // State-driven motion is opt-in: fixed/none describe a stable track (or no
  // track), while follow is the mode that mirrors the originating tool state.
  const motionClass = () => connectorMode() === 'follow'
    ? toolConnectorMotionClass(state())
    : ''
  const colors = () => props.colors ?? {
    // Keep the Solid renderer on the shared theme variable contract.  The
    // appearance snapshot carries indicator glyphs, not the state palette;
    // resolving these vars here preserves user-selected tool colors.
    toolOk: 'var(--tool-ok, var(--state-success, var(--accent)))',
    toolRun: 'var(--tool-run, var(--accent))',
    toolErr: 'var(--tool-err, var(--state-danger, var(--danger)))',
  }
  const color = () => resolveConnectorColor(
    connectorMode(),
    props.status,
    colors(),
    props.appearance.toolConnectorColor || 'rgba(0,0,0,0.12)',
  )
  const width = () => Math.max(1, Math.min(6, props.appearance.toolConnectorWidth || 2))
  const opacity = () => Math.max(0.1, Math.min(1, props.appearance.toolConnectorOpacity ?? 1))

  createEffect(() => {
    const measurementInputs = [
      props.appearance.toolConnectorMode,
      props.appearance.toolConnectorStyle,
      props.appearance.toolConnectorWidth,
      props.appearance.toolConnectorOpacity,
    ]
    if (measurementInputs.length > 0) props.layoutPort.invalidate('theme-changed')
  })

  onMount(() => {
    const unregister = props.layoutPort.registerConnector({
      key: props.connectorKey,
      fromMessageId: props.fromMessageId,
      toMessageId: props.toMessageId,
      measure: () => measureToolConnector(connector, props.coordinateRoot?.()),
      apply(layout) {
        if (!connector) return
        // Keep the node in the layout tree while anchors settle.  `display:
        // none` removes offsetParent and prevents the next invalidation from
        // ever measuring this connector again.
        connector.style.visibility = layout ? 'visible' : 'hidden'
        if (!layout) return
        connector.style.left = `${layout.left}px`
        connector.style.top = `${layout.top}px`
        connector.style.height = `${layout.height}px`
      },
    })
    if (typeof ResizeObserver !== 'undefined' && connector) {
      observer = new ResizeObserver(() => props.layoutPort.invalidate('row-resized'))
      observer.observe(connector)
    }
    props.layoutPort.invalidate('items-changed')
    onCleanup(() => {
      observer?.disconnect()
      unregister()
    })
  })

  return (
    <div
      ref={connector}
      class={`term-tool-connector term-tool-connector-style--${props.appearance.toolConnectorStyle || 'solid'} ${motionClass()}`}
      data-tool-state={state()}
      data-connector-mode={connectorMode()}
      data-from-message-id={props.fromMessageId}
      data-to-message-id={props.toMessageId}
      style={{
        background: color(),
        '--tool-connector-color': color(),
        '--tool-connector-width': `${width()}px`,
        '--tool-connector-opacity': opacity(),
      }}
    />
  )
}

/**
 * One stable overlay owns every Solid connector.  Keeping the line nodes in a
 * single positioned layer removes the old ambiguity where each line inferred
 * a different offset parent from its insertion point.  The layer also owns
 * the broad invalidation observers; individual cards only need to report
 * their own content mutations.
 */
export function SolidToolConnectorLayer(props: SolidToolConnectorLayerProps) {
  let layer: HTMLDivElement | undefined
  let resizeObserver: ResizeObserver | undefined
  let mutationObserver: MutationObserver | undefined
  let appMutationObserver: MutationObserver | undefined
  let settleFrame: number | undefined
  let settleRemaining = 0
  let disposed = false

  const [stableEdges, setStableEdges] = createSignal<readonly StableConnectorEdge[]>([])

  createEffect(() => {
    const incoming = props.edges
    const previous = new Map(untrack(stableEdges).map(edge => [edge.key, edge]))
    const next: StableConnectorEdge[] = []
    const seen = new Set<string>()
    for (const edge of incoming) {
      if (seen.has(edge.key)) continue
      seen.add(edge.key)
      const existing = previous.get(edge.key)
      if (existing) {
        existing.update(edge)
        next.push(existing)
      } else {
        next.push(createStableConnectorEdge(edge))
      }
    }
    setStableEdges(next)
    props.layoutPort.invalidate('items-changed')
  })

  const invalidate = (reason: ToolConnectorInvalidationReason) => {
    if (disposed) return
    props.layoutPort.invalidate(reason)
  }

  // A sidebar/font transition can move the overlay without changing its
  // dimensions.  Re-measure a short, bounded run of frames after each broad
  // signal so lines cannot retain a pre-transition coordinate.
  const stabilize = (reason: ToolConnectorInvalidationReason) => {
    if (disposed) return
    invalidate(reason)
    settleRemaining = Math.max(settleRemaining, 8)
    if (settleFrame !== undefined || typeof requestAnimationFrame !== 'function') return
    const tick = () => {
      settleFrame = undefined
      if (disposed || settleRemaining <= 0) return
      settleRemaining -= 1
      invalidate('manual')
      if (settleRemaining > 0) settleFrame = requestAnimationFrame(tick)
    }
    settleFrame = requestAnimationFrame(tick)
  }

  onMount(() => {
    const term = layer?.closest<HTMLElement>('.term')
    if (!term) return
    const chat = term.closest<HTMLElement>('.chat-view')
    const app = term.closest<HTMLElement>('.app')
    const observed = new Set<Element>()

    const syncObserved = () => {
      if (!resizeObserver) return
      const targets: Element[] = [term]
      if (layer) targets.push(layer)
      if (chat) targets.push(chat)
      if (app) targets.push(app)
      term.querySelectorAll<HTMLElement>('.term-row, .term-tool-head, .term-reasoning-head')
        .forEach(node => targets.push(node))
      const next = new Set(targets.filter(Boolean))
      for (const target of observed) {
        if (next.has(target)) continue
        resizeObserver.unobserve(target)
        observed.delete(target)
      }
      for (const target of next) {
        if (observed.has(target)) continue
        resizeObserver.observe(target)
        observed.add(target)
      }
    }

    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(() => stabilize('row-resized'))
      syncObserved()
    }

    if (typeof MutationObserver !== 'undefined') {
      // Child/text mutations cover delayed renderer mounts and streaming text
      // without observing connector style writes (which would self-trigger).
      mutationObserver = new MutationObserver(() => {
        syncObserved()
        stabilize('items-changed')
      })
      mutationObserver.observe(term, { childList: true, subtree: true, characterData: true })

      // Shell attributes represent sidebar/panel/layout changes.  They can
      // move the coordinate root while leaving its measured size unchanged.
      if (app) {
        appMutationObserver = new MutationObserver(() => stabilize('items-changed'))
        appMutationObserver.observe(app, { attributes: true })
      }
    }

    const onResize = () => stabilize('manual')
    const onTransition = () => stabilize('manual')
    window.addEventListener('resize', onResize)
    window.addEventListener('transitionrun', onTransition, true)
    window.addEventListener('transitionend', onTransition, true)
    const visualViewport = window.visualViewport
    visualViewport?.addEventListener('resize', onResize)

    const fonts = document.fonts
    fonts?.addEventListener?.('loadingdone', onResize)
    fonts?.addEventListener?.('loadingerror', onResize)
    void fonts?.ready.then(() => {
      if (!disposed) stabilize('font-changed')
    })

    stabilize('items-changed')

    onCleanup(() => {
      disposed = true
      if (settleFrame !== undefined && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(settleFrame)
      }
      settleFrame = undefined
      settleRemaining = 0
      resizeObserver?.disconnect()
      mutationObserver?.disconnect()
      appMutationObserver?.disconnect()
      window.removeEventListener('resize', onResize)
      window.removeEventListener('transitionrun', onTransition, true)
      window.removeEventListener('transitionend', onTransition, true)
      visualViewport?.removeEventListener('resize', onResize)
      fonts?.removeEventListener?.('loadingdone', onResize)
      fonts?.removeEventListener?.('loadingerror', onResize)
    })
  })

  return (
    <div ref={layer} class="term-tool-connector-layer" aria-hidden="true">
      <For each={stableEdges()}>{edge => <SolidToolConnector
        connectorKey={edge.key}
        fromMessageId={edge.fromMessageId}
        toMessageId={edge.toMessageId}
        status={edge.status}
        visualState={edge.visualState}
        appearance={edge.appearance}
        layoutPort={props.layoutPort}
        coordinateRoot={() => layer}
      />}</For>
    </div>
  )
}

interface StableConnectorEdge {
  readonly key: string
  readonly fromMessageId: string
  readonly toMessageId: string
  readonly status: ToolConnectorStatus
  readonly visualState?: ToolVisualState
  readonly appearance: ToolConnectorAppearance
  update(next: SolidToolConnectorEdge): void
}

function createStableConnectorEdge(initial: SolidToolConnectorEdge): StableConnectorEdge {
  const [current, setCurrent] = createSignal(initial)
  return {
    get key() { return current().key },
    get fromMessageId() { return current().fromMessageId },
    get toMessageId() { return current().toMessageId },
    get status() { return current().status },
    get visualState() { return current().visualState },
    get appearance() { return current().appearance },
    update: setCurrent,
  }
}
