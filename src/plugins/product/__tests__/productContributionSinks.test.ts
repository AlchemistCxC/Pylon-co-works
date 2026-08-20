import { afterEach, describe, expect, it } from 'vitest'
import {
  AGENT_INSTANCE_SINK_ID,
  TOOL_DICTIONARY_SINK_ID,
  type AgentInstanceSink,
  type ToolDictionarySink,
} from '../../../app/ports/productContributionPorts.ts'
import { TestPluginRuntime } from '../../../plugin-runtime/testing/pluginRuntimeHarness.ts'
import { getPluginServiceRegistry } from '../../../plugin-runtime/runtimeServices.ts'
import { createBuiltinPylonAgentAdaptersPlugin } from '../builtinPylonAgentAdapters.ts'
import { createBuiltinPylonToolsPlugin } from '../builtinPylonTools.ts'
import { listAgentInstances } from '../../../domains/agent/agentRegistry.ts'
import { resolveToolRegistryEntry } from '../../../domains/tool/toolRegistry.ts'

const runtimes: TestPluginRuntime[] = []

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) {
    for (const instance of [...runtime.snapshot().instances].reverse()) {
      await runtime.retryCleanup(instance.identity.key)
    }
  }
})

describe('first-party product data sinks', () => {
  it('registers typed sinks that disappear with their owning runtime instances', async () => {
    const runtime = new TestPluginRuntime()
    runtimes.push(runtime)
    await runtime.activateBuiltin(createBuiltinPylonToolsPlugin())
    await runtime.activateBuiltin(createBuiltinPylonAgentAdaptersPlugin())
    const services = getPluginServiceRegistry()

    const agentSink = services.resolveRequired<AgentInstanceSink>('agent-instance-sink', AGENT_INSTANCE_SINK_ID)
    const dictionarySink = services.resolveRequired<ToolDictionarySink>('tool-dictionary-sink', TOOL_DICTIONARY_SINK_ID)
    agentSink.apply([{ id: 'custom-agent', name: 'Custom', provider: 'not-installed' }])
    dictionarySink.apply({
      custom: [{ name: 'inspect', kind: 'read', action: 'read' }],
    })
    expect(listAgentInstances()).toEqual([
      expect.objectContaining({ agentId: 'custom-agent', state: 'degraded' }),
    ])
    expect(resolveToolRegistryEntry('custom', 'inspect')).toMatchObject({ action: 'read' })

    await runtime.disable('builtin.pylon-agent-adapters')
    expect(() => services.resolveRequired('agent-instance-sink', AGENT_INSTANCE_SINK_ID))
      .toThrow(expect.objectContaining({ code: 'plugin_service_unavailable' }))
    expect(services.resolveRequired('tool-dictionary-sink', TOOL_DICTIONARY_SINK_ID)).toBeDefined()
    expect(listAgentInstances()).toEqual([])

    await runtime.disable('builtin.pylon-tools')
    expect(resolveToolRegistryEntry('custom', 'inspect')).toBeNull()
  })

  it('re-enabled sink is owned by a fresh runtime instance', async () => {
    const runtime = new TestPluginRuntime()
    runtimes.push(runtime)
    const first = await runtime.activateBuiltin(createBuiltinPylonToolsPlugin())
    const services = getPluginServiceRegistry()
    expect(services.getSnapshot().entries.find(entry => entry.value.kind === 'tool-dictionary-sink'))
      .toMatchObject({ ownerRuntimeInstanceId: first.identity.key })

    await runtime.disable('builtin.pylon-tools')
    const second = await runtime.enable('builtin.pylon-tools')

    expect(second.identity.key).not.toBe(first.identity.key)
    expect(services.getSnapshot().entries.find(entry => entry.value.kind === 'tool-dictionary-sink'))
      .toMatchObject({ ownerRuntimeInstanceId: second.identity.key })
  })
})
