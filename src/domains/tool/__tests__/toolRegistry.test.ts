import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  clearToolRegistryForTests,
  applyToolRegistryOverlay,
  getEffectiveToolDictionary,
  getToolDictionaryGeneration,
  listToolRegistryEntries,
  removeToolRegistryOverlay,
  resolveToolSemantic,
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

  it('局部字典 overlay 不删除 provider 的基线工具', () => {
    const before = getEffectiveToolDictionary()
    expect(resolveToolRegistryEntry('peri', 'Write')).toMatchObject({ kind: 'edit', action: 'write' })

    registerToolDictionary({
      peri: [{ name: 'Read', kind: 'read', action: 'read' }],
    })

    expect(resolveToolRegistryEntry('peri', 'Read')).toMatchObject({ kind: 'read', action: 'read' })
    expect(resolveToolRegistryEntry('peri', 'Write')).toMatchObject({ kind: 'edit', action: 'write' })
    expect(getEffectiveToolDictionary().revision).toBe(before.revision + 1)
  })

  it('overlay 校验失败保持旧 snapshot 与 generation', () => {
    const before = getEffectiveToolDictionary()
    expect(() => applyToolRegistryOverlay('test', 'bad-kind', {
      upsert: [{ provider: 'peri', name: 'Read', kind: 'bad', action: 'read' }],
    })).toThrow(/非法 kind/)
    expect(getEffectiveToolDictionary()).toEqual(before)
    expect(resolveToolRegistryEntry('peri', 'Write')).toMatchObject({ action: 'write' })
  })

  it('owner/scope overlay 可独立卸载并重新计算', () => {
    applyToolRegistryOverlay('agent', 'one', { upsert: [{ provider: 'peri', name: 'CustomOne', kind: 'read', action: 'read' }] })
    applyToolRegistryOverlay('agent', 'two', { upsert: [{ provider: 'peri', name: 'CustomTwo', kind: 'edit', action: 'edit' }] })
    expect(resolveToolRegistryEntry('peri', 'CustomOne')).not.toBeNull()
    expect(resolveToolRegistryEntry('peri', 'CustomTwo')).not.toBeNull()
    removeToolRegistryOverlay('agent', 'one')
    expect(resolveToolRegistryEntry('peri', 'CustomOne')).toBeNull()
    expect(resolveToolRegistryEntry('peri', 'CustomTwo')).not.toBeNull()
  })

  it('generation seam 可读取旧的不可变语义快照', () => {
    const generation = getToolDictionaryGeneration()
    applyToolRegistryOverlay('test', 'generation', { upsert: [{ provider: 'peri', name: 'Read', kind: 'execute', action: 'execute' }] })
    expect(resolveToolSemantic('peri', 'Read', generation)).toMatchObject({ kind: 'read', action: 'read' })
    expect(resolveToolSemantic('peri', 'Read')).toMatchObject({ kind: 'execute', action: 'execute' })
  })

  it('remove 与 alias 更新在单次发布后生效，并拒绝未知目标与循环', () => {
    const before = getEffectiveToolDictionary()
    expect(() => applyToolRegistryOverlay('test', 'bad-alias', { aliases: { peri: { missing: 'NoSuchTool' } } })).toThrow(/alias target 未知/)
    expect(getEffectiveToolDictionary()).toEqual(before)
    applyToolRegistryOverlay('test', 'aliases', {
      upsert: [{ provider: 'peri', name: 'AliasTarget', kind: 'read', action: 'read' }],
      aliases: { peri: { Alias: 'AliasTarget' } },
    })
    expect(resolveToolRegistryEntry('peri', 'Alias')).toMatchObject({ name: 'AliasTarget' })
    applyToolRegistryOverlay('test', 'remove', { remove: ['peri/AliasTarget'] })
    expect(resolveToolRegistryEntry('peri', 'AliasTarget')).toBeNull()
    expect(() => applyToolRegistryOverlay('test', 'cycle', {
      aliases: { peri: { one: 'two', two: 'one' } },
    })).toThrow(/alias target 未知|alias 循环/)
  })
})
