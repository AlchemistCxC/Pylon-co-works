import { describe, expect, it } from 'vitest'
import { createPluginIdentity } from '../../pluginIdentity.ts'
import {
  PluginServiceRegistry,
  PluginServiceResolutionError,
} from '../pluginServiceRegistry.ts'

describe('PluginServiceRegistry required contribution resolution', () => {
  it('resolves the single matching service by kind and optional id', () => {
    const registry = new PluginServiceRegistry()
    const service = { apply: () => undefined }
    registry.register(createPluginIdentity('builtin.provider', 'run-1'), {
      kind: 'agent-instance-sink',
      id: 'pylon.agent-instances',
      value: service,
    })

    expect(registry.resolveRequired('agent-instance-sink')).toBe(service)
    expect(registry.resolveRequired('agent-instance-sink', 'pylon.agent-instances')).toBe(service)
  })

  it('returns a structured unavailable error when no contribution matches', () => {
    const registry = new PluginServiceRegistry()

    expect(() => registry.resolveRequired('tool-dictionary-sink', 'pylon.tool-dictionary'))
      .toThrow(expect.objectContaining<Partial<PluginServiceResolutionError>>({
        name: 'PluginServiceResolutionError',
        code: 'plugin_service_unavailable',
        kind: 'tool-dictionary-sink',
        serviceId: 'pylon.tool-dictionary',
      }))
  })

  it('returns a structured ambiguity error instead of choosing an arbitrary provider', () => {
    const registry = new PluginServiceRegistry()
    registry.register(createPluginIdentity('provider.first', 'run-1'), {
      kind: 'agent-instance-sink', id: 'first', value: { apply: () => undefined },
    })
    registry.register(createPluginIdentity('provider.second', 'run-1'), {
      kind: 'agent-instance-sink', id: 'second', value: { apply: () => undefined },
    })

    expect(() => registry.resolveRequired('agent-instance-sink'))
      .toThrow(expect.objectContaining<Partial<PluginServiceResolutionError>>({
        code: 'plugin_service_ambiguous',
        kind: 'agent-instance-sink',
        matchCount: 2,
      }))
  })

  it('switches required service ownership atomically and ignores a stale disposer', async () => {
    const registry = new PluginServiceRegistry()
    const oldOwner = createPluginIdentity('builtin.provider', 'run-1')
    const newOwner = createPluginIdentity('builtin.provider', 'run-2')
    const oldService = { generation: 'old' }
    const newService = { generation: 'new' }
    const oldRegistration = registry.register(oldOwner, {
      kind: 'agent-instance-sink', id: 'pylon.agent-instances', value: oldService,
    })
    const transaction = registry.beginShadowTransaction(newOwner, oldOwner.key)
    transaction.register({
      kind: 'agent-instance-sink', id: 'pylon.agent-instances', value: newService,
    }, { contributionId: 'agent-instance-sink:pylon.agent-instances' })
    transaction.validate()
    const registrations = transaction.commit()

    expect(registry.resolveRequired('agent-instance-sink', 'pylon.agent-instances')).toBe(newService)
    expect(registry.getSnapshot().entries[0]?.ownerRuntimeInstanceId).toBe(newOwner.key)
    await oldRegistration.dispose()
    expect(registry.resolveRequired('agent-instance-sink', 'pylon.agent-instances')).toBe(newService)

    await registrations[0]?.dispose()
    expect(() => registry.resolveRequired('agent-instance-sink', 'pylon.agent-instances'))
      .toThrow(expect.objectContaining({ code: 'plugin_service_unavailable' }))
  })
})
