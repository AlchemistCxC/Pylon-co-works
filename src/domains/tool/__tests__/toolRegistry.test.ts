import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  clearToolRegistryForTests,
  listToolRegistryEntries,
  registerToolDictionary,
  registerToolRegistryEntry,
  resolveToolRegistryEntry,
  unregisterToolRegistryProvider,
} from '../toolRegistry.ts'

beforeEach(() => clearToolRegistryForTests())
afterEach(() => clearToolRegistryForTests())

describe('provider-scoped tool registry', () => {
  it('允许不同 provider 使用同名 Tool 且解析不串', () => {
    registerToolRegistryEntry({ provider: 'agent-a', name: 'inspect', kind: 'read', action: 'read' })
    registerToolRegistryEntry({ provider: 'agent-b', name: 'inspect', kind: 'execute', action: 'execute' })

    expect(resolveToolRegistryEntry('agent-a', 'inspect')).toMatchObject({ provider: 'agent-a', kind: 'read' })
    expect(resolveToolRegistryEntry('agent-b', 'inspect')).toMatchObject({ provider: 'agent-b', kind: 'execute' })
    expect(listToolRegistryEntries('agent-a')).toHaveLength(1)
    expect(listToolRegistryEntries('agent-b')).toHaveLength(1)
  })

  it('alias 仅在所属 provider 作用域内生效', () => {
    registerToolRegistryEntry({ provider: 'agent-a', name: 'inspect_repo', aliases: ['inspect'], kind: 'read', action: 'read' })

    expect(resolveToolRegistryEntry('agent-a', 'inspect')).toMatchObject({ name: 'inspect_repo' })
    expect(resolveToolRegistryEntry('agent-b', 'inspect')).toBeNull()
  })

  it('按 provider 卸载 entries，不影响其他 provider 与内置基线（P1-4）', () => {
    registerToolRegistryEntry({ provider: 'agent-a', name: 'inspect', kind: 'read', action: 'read' })
    registerToolRegistryEntry({ provider: 'agent-b', name: 'inspect', kind: 'execute', action: 'execute' })

    unregisterToolRegistryProvider('agent-a')

    expect(resolveToolRegistryEntry('agent-a', 'inspect')).toBeNull()
    expect(resolveToolRegistryEntry('agent-b', 'inspect')).toMatchObject({ provider: 'agent-b', kind: 'execute' })
    expect(resolveToolRegistryEntry('peri', 'Bash')).toMatchObject({ provider: 'peri', kind: 'execute' })
  })

  it('registerToolDictionary 按 provider 覆盖内置项并解析 snake_case 字段', () => {
    registerToolDictionary({
      peri: [{ name: 'Read', aliases: ['read'], kind: 'read', action: 'read', summary_fields: ['file_path'], output_label: 'lines' }],
      hermes: [{ name: 'read_file', kind: 'read', action: 'read', summary_fields: ['path'] }],
    })

    expect(resolveToolRegistryEntry('peri', 'Read')).toMatchObject({
      provider: 'peri',
      kind: 'read',
      summaryFields: ['file_path'],
      outputLabel: 'lines',
    })
    expect(resolveToolRegistryEntry('hermes', 'read_file')).toMatchObject({ provider: 'hermes', kind: 'read' })
  })
})
