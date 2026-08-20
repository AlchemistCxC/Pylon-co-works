import { describe, expect, it, vi } from 'vitest'
import { createPluginIdentity } from '../../pluginIdentity'
import { PluginScope } from '../../pluginScope'
import { CommandRegistry } from '../commandRegistry'
import { createPluginCommandApi } from '../pluginCommandApi'

describe('CommandRegistry', () => {
  it('注册、描述、别名执行与 owner 过滤共用单一 Registry', async () => {
    const registry = new CommandRegistry()
    const owner = createPluginIdentity('p.command', 'run-1')
    const execute = vi.fn(async ({ args }) => ({ args }))
    registry.register(owner, {
      id: 'p.command.inspect',
      name: 'inspect',
      aliases: ['i'],
      description: '检查',
      priority: 10,
      execute,
    })

    expect(registry.describe('inspect')).toMatchObject({
      id: 'p.command.inspect',
      ownerPluginId: 'p.command',
      executable: true,
    })
    await expect(registry.execute('i', { target: 'x' })).resolves.toEqual({ args: { target: 'x' } })
    expect(registry.list({ ownerPluginIds: ['missing'] })).toEqual([])
  })

  it('PluginCommandApi 自动把 registration 收入 Scope', async () => {
    const registry = new CommandRegistry()
    const owner = createPluginIdentity('p.scope-command', 'run-1')
    const scope = new PluginScope(owner.key)
    const api = createPluginCommandApi(registry, owner, scope)

    api.register({ id: 'hello', name: 'hello', description: '你好', priority: 1 })
    expect(registry.list()).toHaveLength(1)
    expect(scope.size).toBe(1)

    await scope.dispose()
    expect(registry.list()).toEqual([])
  })

  it('不存在或无 handler 的命令明确拒绝执行', async () => {
    const registry = new CommandRegistry()
    const owner = createPluginIdentity('p.metadata', 'run-1')
    registry.register(owner, { id: 'metadata', name: 'metadata', description: '元数据', priority: 1 })

    await expect(registry.execute('missing')).rejects.toThrow('命令不存在')
    await expect(registry.execute('metadata')).rejects.toThrow('命令不可执行')
  })
})
