import { describe, expect, it } from 'vitest'
import {
  resolvePluginContracts,
  type PluginContract,
} from '../pluginContractResolver.ts'

function contract(
  id: string,
  version: string,
  dependencies: Readonly<Record<string, string>> = {},
): PluginContract {
  return { id, version, enabled: true, dependencies }
}

describe('plugin contract resolver', () => {
  it('orders enabled dependencies stably before their consumers', () => {
    const result = resolvePluginContracts([
      contract('feature.consumer', '1.0.0', {
        'service.exact': '2.1.0',
        'service.caret': '^1.2.3',
        'service.any': '*',
      }),
      contract('service.any', '9.0.0'),
      contract('service.caret', '1.9.0'),
      contract('service.exact', '2.1.0'),
    ])

    expect(result.blocked).toEqual([])
    expect(result.eligibleIds).toEqual([
      'service.any',
      'service.caret',
      'service.exact',
      'feature.consumer',
    ])
  })

  it('blocks a consumer whose required dependency version is incompatible', () => {
    const result = resolvePluginContracts([
      contract('service.clock', '2.0.0'),
      contract('feature.consumer', '1.0.0', { 'service.clock': '^1.2.0' }),
    ])

    expect(result.eligibleIds).toEqual(['service.clock'])
    expect(result.blocked).toEqual([expect.objectContaining({
      pluginId: 'feature.consumer',
      code: 'dependency_version_mismatch',
      blocking: true,
      relatedPluginIds: ['service.clock'],
    })])
  })

  it('blocks a consumer when a required dependency is absent', () => {
    const result = resolvePluginContracts([
      contract('feature.consumer', '1.0.0', { 'service.missing': '*' }),
    ])

    expect(result.eligibleIds).toEqual([])
    expect(result.blocked).toEqual([expect.objectContaining({
      pluginId: 'feature.consumer',
      code: 'dependency_missing',
      relatedPluginIds: ['service.missing'],
    })])
  })

  it('blocks every member of a required dependency cycle', () => {
    const result = resolvePluginContracts([
      contract('feature.a', '1.0.0', { 'feature.b': '*' }),
      contract('feature.b', '1.0.0', { 'feature.a': '*' }),
    ])

    expect(result.eligibleIds).toEqual([])
    expect(result.blocked).toEqual(expect.arrayContaining([
      expect.objectContaining({ pluginId: 'feature.a', code: 'dependency_cycle' }),
      expect.objectContaining({ pluginId: 'feature.b', code: 'dependency_cycle' }),
    ]))
  })

  it('blocks both enabled plugins when either side declares a conflict', () => {
    const result = resolvePluginContracts([
      { ...contract('feature.alpha', '1.0.0'), conflicts: ['feature.beta'] },
      contract('feature.beta', '1.0.0'),
    ])

    expect(result.eligibleIds).toEqual([])
    expect(result.blocked).toEqual(expect.arrayContaining([
      expect.objectContaining({ pluginId: 'feature.alpha', code: 'plugin_conflict' }),
      expect.objectContaining({ pluginId: 'feature.beta', code: 'plugin_conflict' }),
    ]))
  })

  it('reports an optional dependency mismatch without blocking activation', () => {
    const result = resolvePluginContracts([
      contract('service.clock', '2.0.0'),
      {
        ...contract('feature.consumer', '1.0.0'),
        optionalDependencies: {
          'service.clock': '^1.0.0',
          'service.absent': '*',
        },
      },
    ])

    expect(result.eligibleIds).toEqual(['feature.consumer', 'service.clock'])
    expect(result.blocked).toEqual([])
    expect(result.diagnostics).toEqual([expect.objectContaining({
      pluginId: 'feature.consumer',
      code: 'optional_dependency_version_mismatch',
      blocking: false,
      relatedPluginIds: ['service.clock'],
    })])
  })

  it('keeps an enabled plugin waiting until one activation event is emitted', () => {
    const deferred = {
      ...contract('feature.deferred', '1.0.0'),
      activationEvents: ['workspace.opened', 'command:feature.run'],
    }

    const waiting = resolvePluginContracts([deferred], ['kernel.ready'])
    expect(waiting.eligibleIds).toEqual([])
    expect(waiting.diagnostics).toEqual([expect.objectContaining({
      pluginId: 'feature.deferred',
      code: 'waiting_activation',
      blocking: false,
    })])

    const activated = resolvePluginContracts([deferred], ['command:feature.run'])
    expect(activated.eligibleIds).toEqual(['feature.deferred'])
    expect(activated.diagnostics).toEqual([])
  })
})
