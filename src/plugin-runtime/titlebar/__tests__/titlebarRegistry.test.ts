import { describe, expect, it } from 'vitest'
import { createPluginIdentity } from '../../pluginIdentity.ts'
import { TitlebarRegistry } from '../titlebarRegistry.ts'

const Button = () => null

describe('TitlebarRegistry', () => {
  it('注册期 fail-closed：slot / renderKind / commandId 三者的配对错了就拒绝', () => {
    const registry = new TitlebarRegistry()
    const owner = createPluginIdentity('test.titlebar.validation', 'run')
    const options = { contributionId: 'x', priority: 0 }
    const register = (value: Parameters<TitlebarRegistry['register']>[1]) => registry.register(owner, value, options)

    // 菜单项必须带可执行的命令 id —— 否则是一次点击后无反馈的死路。
    expect(() => register({ id: 'menu.empty', slot: 'app-menu', renderKind: 'command', label: '空命令', commandId: '' })).toThrow(/commandId/)
    // slot 与 renderKind 互相绑定：菜单项只能是 command，其它槽位不能是 command。
    expect(() => register({ id: 'menu.react', slot: 'app-menu', renderKind: 'first-party-react', label: '错配', component: Button } as never)).toThrow(/renderKind='command'/)
    expect(() => register({ id: 'actions.command', slot: 'app-actions', renderKind: 'command', label: '错配', commandId: 'a.b' } as never)).toThrow(/只用于 slot='app-menu'/)
    // 槽位拼错会安静地永不渲染，必须在注册期拦下。
    expect(() => register({ id: 'slot.typo', slot: 'app-menus', renderKind: 'command', label: '错槽', commandId: 'a.b' } as never)).toThrow(/slot 非法/)
    // id / label 的空值与首尾空格。
    expect(() => register({ id: ' spaced ', slot: 'app-actions', renderKind: 'first-party-react', label: 'x', component: Button })).toThrow(/id/)
    expect(() => register({ id: 'blank', slot: 'app-actions', renderKind: 'first-party-react', label: '  ', component: Button })).toThrow(/label/)
    // 合法的菜单项通过，并被冻结。
    const handle = register({ id: 'menu.ok', slot: 'app-menu', renderKind: 'command', label: '合法', commandId: 'a.b' })
    expect(registry.getSnapshot().entries[0].value).toEqual({ id: 'menu.ok', slot: 'app-menu', renderKind: 'command', label: '合法', commandId: 'a.b' })
    handle.dispose()
    expect(registry.getSnapshot().entries).toEqual([])
  })

  it('keeps transaction isolation, caller ordering and shadow revert', () => {
    const registry = new TitlebarRegistry()
    const owner = createPluginIdentity('test.titlebar', 'old')
    const value = { id: 'view-id', slot: 'app-actions' as const, label: 'Action',
      renderKind: 'first-party-react' as const, component: Button }
    const transaction = registry.beginTransaction(owner)
    transaction.register(value, { contributionId: 'entry-id', priority: 0, layer: 'override' })
    expect(registry.getSnapshot().entries).toEqual([])
    transaction.commit()
    const before = registry.getSnapshot()
    expect(before.entries[0]).toMatchObject({ contributionId: 'entry-id', priority: 0, layer: 'override', value })
    const next = createPluginIdentity('test.titlebar', 'next')
    const shadow = registry.beginShadowTransaction(next, owner.key)
    shadow.register({ ...value, label: 'Next' }, { contributionId: 'entry-id' })
    expect(registry.getSnapshot()).toBe(before)
    shadow.commit()
    expect(registry.getSnapshot().entries[0].value.label).toBe('Next')
    shadow.revert()
    expect(registry.getSnapshot().entries).toEqual(before.entries)
  })

  it('publishes ordered contributions and disposes them', () => {
    const registry = new TitlebarRegistry()
    const owner = createPluginIdentity('test.titlebar', 'run-1')
    const first = registry.register(owner, { id: 'first', slot: 'app-actions', label: 'First', renderKind: 'first-party-react', component: Button }, { contributionId: 'first', priority: 100 })
    registry.register(owner, { id: 'second', slot: 'app-actions', label: 'Second', renderKind: 'first-party-react', component: Button }, { contributionId: 'second', priority: 200 })
    expect(registry.getSnapshot().entries.map(entry => entry.contributionId)).toEqual(['first', 'second'])
    first.dispose()
    expect(registry.getSnapshot().entries.map(entry => entry.contributionId)).toEqual(['second'])
  })
})
