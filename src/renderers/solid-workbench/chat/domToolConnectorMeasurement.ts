import type {
  ToolAnchorMeasurement,
  ToolConnectorMeasurement,
} from '../../../domains/workbench/toolConnectorLayoutPort.ts'

export function measureToolAnchor(
  head: HTMLElement | undefined,
  indicator: HTMLElement | undefined,
): ToolAnchorMeasurement | null {
  if (!head || !indicator) return null
  return {
    head: rectSnapshot(head.getBoundingClientRect()),
    indicator: rectSnapshot(indicator.getBoundingClientRect()),
  }
}

export function measureToolConnector(connector: HTMLElement | undefined): ToolConnectorMeasurement | null {
  const parent = connector?.offsetParent as HTMLElement | null | undefined
  if (!connector || !parent) return null
  return {
    parent: rectSnapshot(parent.getBoundingClientRect()),
    width: connector.offsetWidth,
  }
}

function rectSnapshot(rect: DOMRect): { top: number; left: number; width: number; height: number } {
  return { top: rect.top, left: rect.left, width: rect.width, height: rect.height }
}
