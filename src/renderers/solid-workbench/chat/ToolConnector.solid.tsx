import { createEffect, onCleanup, onMount } from 'solid-js'
import { resolveConnectorColor, type ToolConnectorStatus } from '../../../domains/tool/toolPresentation.ts'
import { toolConnectorMotionClass } from '../../../components/chat/toolIndicatorMotion.ts'
import type { ToolVisualState } from '../../../domains/tool/status.ts'
import type { WorkbenchAppearanceSnapshot } from '../../../domains/workbench/appearance.ts'
import type { ToolConnectorLayoutPort } from '../../../domains/workbench/toolConnectorLayoutPort.ts'
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
}

export function SolidToolConnector(props: SolidToolConnectorProps) {
  let connector: HTMLDivElement | undefined
  let observer: ResizeObserver | undefined
  const state = () => props.visualState ?? 'unknown'
  const color = () => resolveConnectorColor(
    props.appearance.toolConnectorMode,
    props.status,
    props.colors ?? {},
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
      measure: () => measureToolConnector(connector),
      apply(layout) {
        if (!connector) return
        connector.style.display = layout ? 'block' : 'none'
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
      class={`term-tool-connector term-tool-connector-style--${props.appearance.toolConnectorStyle || 'solid'} ${toolConnectorMotionClass(state())}`}
      data-tool-state={state()}
      data-connector-mode={props.appearance.toolConnectorMode || 'fixed'}
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
