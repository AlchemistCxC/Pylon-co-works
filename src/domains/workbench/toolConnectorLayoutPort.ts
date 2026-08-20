export interface LayoutRect {
  top: number
  left: number
  width: number
  height: number
}

export interface ToolAnchorMeasurement {
  head: LayoutRect
  indicator: LayoutRect
}

export interface ToolConnectorMeasurement {
  parent: LayoutRect
  width: number
}

export interface ToolConnectorLayout {
  left: number
  top: number
  height: number
}

export type ToolConnectorInvalidationReason =
  | 'items-changed'
  | 'row-resized'
  | 'theme-changed'
  | 'font-changed'
  | 'manual'

export interface ToolConnectorRegistration {
  key: string
  fromMessageId: string
  toMessageId: string
  measure(): ToolConnectorMeasurement | null
  apply(layout: ToolConnectorLayout | null): void
}

export interface ToolConnectorLayoutPort {
  registerTool(messageId: string, measure: () => ToolAnchorMeasurement | null): () => void
  registerConnector(registration: ToolConnectorRegistration): () => void
  invalidate(reason: ToolConnectorInvalidationReason): void
  destroy(): void
}

export interface ToolConnectorScheduler {
  schedule(callback: () => void): unknown
  cancel(handle: unknown): void
}

export function calculateToolConnectorLayout(
  from: ToolAnchorMeasurement,
  to: ToolAnchorMeasurement,
  connector: ToolConnectorMeasurement,
): ToolConnectorLayout {
  const fromCenter = from.head.top - connector.parent.top + from.head.height / 2
  const toCenter = to.head.top - connector.parent.top + to.head.height / 2
  return {
    left: from.indicator.left - connector.parent.left + from.indicator.width / 2 - connector.width / 2,
    top: fromCenter,
    height: Math.max(0, toCenter - fromCenter),
  }
}

export function createToolConnectorLayoutPort(
  scheduler: ToolConnectorScheduler = animationFrameScheduler(),
): ToolConnectorLayoutPort {
  const tools = new Map<string, () => ToolAnchorMeasurement | null>()
  const connectors = new Map<string, ToolConnectorRegistration>()
  let scheduled: unknown | null = null
  let destroyed = false

  const measure = () => {
    scheduled = null
    if (destroyed) return
    for (const connector of connectors.values()) {
      const from = tools.get(connector.fromMessageId)?.() ?? null
      const to = tools.get(connector.toMessageId)?.() ?? null
      const target = connector.measure()
      connector.apply(from && to && target ? calculateToolConnectorLayout(from, to, target) : null)
    }
  }

  const port: ToolConnectorLayoutPort = {
    registerTool(messageId, read) {
      if (destroyed) return () => {}
      tools.set(messageId, read)
      port.invalidate('items-changed')
      return () => {
        if (tools.get(messageId) === read) tools.delete(messageId)
        port.invalidate('items-changed')
      }
    },
    registerConnector(registration) {
      if (destroyed) return () => {}
      connectors.set(registration.key, registration)
      port.invalidate('items-changed')
      return () => {
        if (connectors.get(registration.key) === registration) connectors.delete(registration.key)
        registration.apply(null)
      }
    },
    invalidate() {
      if (destroyed || scheduled !== null) return
      scheduled = scheduler.schedule(measure)
    },
    destroy() {
      if (destroyed) return
      destroyed = true
      if (scheduled !== null) scheduler.cancel(scheduled)
      scheduled = null
      for (const connector of connectors.values()) connector.apply(null)
      connectors.clear()
      tools.clear()
    },
  }

  return port
}

function animationFrameScheduler(): ToolConnectorScheduler {
  return {
    schedule(callback) {
      if (typeof requestAnimationFrame === 'function') return requestAnimationFrame(callback)
      return setTimeout(callback, 0)
    },
    cancel(handle) {
      if (typeof cancelAnimationFrame === 'function' && typeof handle === 'number') cancelAnimationFrame(handle)
      else clearTimeout(handle as ReturnType<typeof setTimeout>)
    },
  }
}
