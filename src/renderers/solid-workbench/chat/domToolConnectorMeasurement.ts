import type {
  ToolAnchorMeasurement,
  ToolConnectorMeasurement,
} from '../../../domains/workbench/toolConnectorLayoutPort.ts'

export function measureToolAnchor(
  head: HTMLElement | undefined,
  indicator: HTMLElement | undefined,
): ToolAnchorMeasurement | null {
  if (!head || !indicator) return null
  const indicatorBox = indicator.getBoundingClientRect()
  return {
    head: rectSnapshot(head.getBoundingClientRect()),
    // The indicator owns a fixed gutter, but its glyph is intentionally
    // left-aligned inside that gutter.  Connecting to the element's midpoint
    // therefore puts the line several pixels to the right of the visible dot.
    // Measure the rendered contents when possible and fall back to the gutter
    // box for custom/empty indicators.
    indicator: rectSnapshot(measureIndicatorContent(indicator, indicatorBox)),
  }
}

function measureIndicatorContent(indicator: HTMLElement, fallback: DOMRect): DOMRect {
  if (typeof document === 'undefined' || typeof document.createRange !== 'function') return fallback
  try {
    const range = document.createRange()
    range.selectNodeContents(indicator)
    const rects = [...range.getClientRects()].filter(rect => rect.width > 0 && rect.height > 0)
    if (rects.length === 0) return fallback
    const left = Math.min(...rects.map(rect => rect.left))
    const top = Math.min(...rects.map(rect => rect.top))
    const right = Math.max(...rects.map(rect => rect.right))
    const bottom = Math.max(...rects.map(rect => rect.bottom))
    return new DOMRect(left, top, right - left, bottom - top)
  } catch {
    // A detached or not-yet-laid-out indicator can reject range measurement;
    // its element box remains a valid alignment fallback.
    return fallback
  }
}

export function measureToolConnector(
  connector: HTMLElement | undefined,
  coordinateRoot?: HTMLElement,
): ToolConnectorMeasurement | null {
  if (!connector) return null
  // All Solid connectors now live in one overlay.  Prefer that explicit root
  // so the coordinates written by the layout port always use the same box as
  // the absolutely positioned line.  The fallbacks keep the helper safe for
  // legacy callers and for the short interval before the overlay is mounted.
  const parent = (coordinateRoot?.isConnected ? coordinateRoot : undefined)
    ?? (connector.offsetParent as HTMLElement | null)
    ?? connector.closest<HTMLElement>('.term')
    ?? connector.parentElement
  if (!parent) return null
  const parentRect = parent.getBoundingClientRect()
  // Hidden Sheet/virtualized content has zero geometry.  Do not apply a
  // plausible-looking but stale line; the next observer invalidation will
  // measure again once the root is laid out.
  if (parentRect.width <= 0 || parentRect.height <= 0) return null
  const computedStyle = typeof getComputedStyle === 'function' ? getComputedStyle(connector) : undefined
  const computedWidth = computedStyle ? Number.parseFloat(computedStyle.width) : Number.NaN
  const configuredWidth = computedStyle
    ? Number.parseFloat(computedStyle.getPropertyValue('--tool-connector-width'))
    : Number.NaN
  return {
    parent: rectSnapshot(parentRect),
    width: connector.offsetWidth || (Number.isFinite(computedWidth) ? computedWidth : 0)
      || (Number.isFinite(configuredWidth) ? configuredWidth : 1),
  }
}

function rectSnapshot(rect: DOMRect): { top: number; left: number; width: number; height: number } {
  return { top: rect.top, left: rect.left, width: rect.width, height: rect.height }
}
