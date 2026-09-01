import { describe, expect, it } from 'vitest'
import {
  createAgentClient,
  normalizeProtocolAdapterCatalog,
} from '../agentClient'
import { FakeInvoke } from '../../../test/fakeInvoke'

describe('protocol adapter catalog contract', () => {
  it('normalizes baseline/runtime split and filters malformed entries', () => {
    const catalog = normalizeProtocolAdapterCatalog({
      schemaVersion: 1,
      recognizedMethods: [' session/request_permission ', '', 42, 'session/request_permission'],
      supportedInteractions: [
        { method: 'terminal/create', aliases: ['terminal/create', null, ''], kind: 'client-request' },
        null,
        { method: '', kind: 'bad' },
      ],
      providers: [
        {
          provider: ' HERMES ',
          displayName: 'Hermes',
          catalogKnown: true,
          adapterRegistered: true,
          adapterMethods: ['session/request_permission', 'session/request_permission', 3],
          responseMethods: ['session/request_permission'],
          interactionKinds: ['clarify', 'approval'],
          baseline: {
            provider: 'hermes',
            displayName: 'Hermes',
            sessionUpdates: true,
            interactionEvents: true,
            permissionRequests: false,
            replay: true,
            responseMethods: [],
            interactionKinds: ['clarify'],
            setModelApi: 'set_model',
          },
          configuredAgentIds: ['hermes-main', 'hermes-main', null],
        },
        { provider: '', catalogKnown: true },
      ],
    })

    expect(catalog.schemaVersion).toBe(1)
    expect(catalog.recognizedMethods).toEqual(['session/request_permission'])
    expect(catalog.supportedInteractions).toEqual([
      {
        method: 'terminal/create',
        aliases: ['terminal/create'],
        kind: 'client-request',
        responseMethod: 'json-rpc',
      },
    ])
    expect(catalog.providers[0]).toMatchObject({
      provider: 'hermes',
      adapterRegistered: true,
      adapterMethods: ['session/request_permission'],
      configuredAgentIds: ['hermes-main'],
    })
    expect(catalog.providers[0].baseline?.permissionRequests).toBe(false)
  })

  it('returns a safe empty projection for a missing/old host command', () => {
    expect(normalizeProtocolAdapterCatalog(null)).toEqual({
      schemaVersion: 1,
      recognizedMethods: [],
      supportedInteractions: [],
      providers: [],
    })
    expect(normalizeProtocolAdapterCatalog({ schemaVersion: 'old', providers: 'bad' })).toEqual({
      schemaVersion: 1,
      recognizedMethods: [],
      supportedInteractions: [],
      providers: [],
    })
  })

  it('typed client uses the read-only command and preserves invoke errors', async () => {
    const invoke = new FakeInvoke().register('protocol_adapter_catalog', () => ({
      schemaVersion: 1,
      recognizedMethods: ['terminal/create'],
      supportedInteractions: [],
      providers: [],
    }))
    const client = createAgentClient({ invoke: (cmd, args) => invoke.invoke(cmd, args) })
    await expect(client.protocolAdapterCatalog()).resolves.toMatchObject({
      recognizedMethods: ['terminal/create'],
    })
    expect(invoke.calls).toEqual([{ cmd: 'protocol_adapter_catalog', args: {} }])

    const failure = new FakeInvoke().register('protocol_adapter_catalog', () => {
      throw new Error('catalog unavailable')
    })
    const failingClient = createAgentClient({ invoke: (cmd, args) => failure.invoke(cmd, args) })
    await expect(failingClient.protocolAdapterCatalog()).rejects.toThrow('catalog unavailable')
  })
})
