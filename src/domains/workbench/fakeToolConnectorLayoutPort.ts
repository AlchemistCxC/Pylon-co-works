import type {
  ToolAnchorMeasurement,
  ToolConnectorInvalidationReason,
  ToolConnectorLayoutPort,
  ToolConnectorRegistration,
} from './toolConnectorLayoutPort.ts'

export interface FakeToolConnectorLayoutPort extends ToolConnectorLayoutPort {
  readonly toolIds: readonly string[]
  readonly connectorKeys: readonly string[]
  readonly invalidations: readonly ToolConnectorInvalidationReason[]
  readonly destroyed: boolean
}

export function createFakeToolConnectorLayoutPort(): FakeToolConnectorLayoutPort {
  const tools = new Map<string, () => ToolAnchorMeasurement | null>()
  const connectors = new Map<string, ToolConnectorRegistration>()
  const invalidations: ToolConnectorInvalidationReason[] = []
  let destroyed = false

  return {
    get toolIds() { return [...tools.keys()] },
    get connectorKeys() { return [...connectors.keys()] },
    get invalidations() { return invalidations },
    get destroyed() { return destroyed },
    registerTool(messageId, measure) {
      if (destroyed) return () => {}
      tools.set(messageId, measure)
      return () => { if (tools.get(messageId) === measure) tools.delete(messageId) }
    },
    registerConnector(registration) {
      if (destroyed) return () => {}
      connectors.set(registration.key, registration)
      return () => {
        if (connectors.get(registration.key) === registration) connectors.delete(registration.key)
        registration.apply(null)
      }
    },
    invalidate(reason) {
      if (!destroyed) invalidations.push(reason)
    },
    destroy() {
      if (destroyed) return
      destroyed = true
      for (const connector of connectors.values()) connector.apply(null)
      connectors.clear()
      tools.clear()
    },
  }
}
