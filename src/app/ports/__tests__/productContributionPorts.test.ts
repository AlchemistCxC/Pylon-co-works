import { describe, expect, it, vi } from 'vitest'
import { createPluginIdentity } from '../../../plugin-runtime/pluginIdentity.ts'
import {
  PluginServiceRegistry,
  PluginServiceResolutionError,
} from '../../../plugin-runtime/services/pluginServiceRegistry.ts'
import {
  AGENT_INSTANCE_SINK_ID,
  TOOL_DICTIONARY_SINK_ID,
  applyAgentInstancesThroughPort,
  applyToolDictionaryThroughPort,
} from '../productContributionPorts.ts'

describe('Product contribution ports', () => {
  it('routes backend agent and dictionary data through active plugin-owned sinks', () => {
    const registry = new PluginServiceRegistry()
    const applyAgents = vi.fn()
    const applyDictionary = vi.fn()
    const owner = createPluginIdentity('builtin.product-data', 'run-1')
    registry.register(owner, {
      kind: 'agent-instance-sink', id: AGENT_INSTANCE_SINK_ID, value: { apply: applyAgents },
    })
    registry.register(owner, {
      kind: 'tool-dictionary-sink', id: TOOL_DICTIONARY_SINK_ID, value: { apply: applyDictionary },
    })

    const agents = [{ id: 'peri', name: 'Peri' }]
    const dictionary = { peri: { Read: 'read' } }
    applyAgentInstancesThroughPort(registry, agents)
    applyToolDictionaryThroughPort(registry, dictionary)

    expect(applyAgents).toHaveBeenCalledWith(agents)
    expect(applyDictionary).toHaveBeenCalledWith(dictionary)
  })

  it('reports unavailable after the owning plugin contribution is disposed', async () => {
    const registry = new PluginServiceRegistry()
    const registration = registry.register(createPluginIdentity('builtin.product-data', 'run-1'), {
      kind: 'tool-dictionary-sink', id: TOOL_DICTIONARY_SINK_ID, value: { apply: vi.fn() },
    })
    await registration.dispose()

    expect(() => applyToolDictionaryThroughPort(registry, {}))
      .toThrow(expect.objectContaining<Partial<PluginServiceResolutionError>>({
        code: 'plugin_service_unavailable',
        kind: 'tool-dictionary-sink',
      }))
  })
})
