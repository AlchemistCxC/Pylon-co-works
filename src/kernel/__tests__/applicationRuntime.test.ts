// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { createApplicationRuntime } from '../applicationRuntime'
import { createPluginIdentity } from '../../plugin-runtime/pluginIdentity.ts'

const ApplicationA = () => null
const ApplicationB = () => null

describe('ApplicationRuntime', () => {
  it('注册、挂载、卸载会发布稳定 snapshot', () => {
    const runtime = createApplicationRuntime()
    const listener = vi.fn()
    runtime.subscribe(listener)

    runtime.registerBuiltin({ id: 'builtin.a', component: ApplicationA })
    runtime.mount('builtin.a')
    expect(runtime.getSnapshot()).toMatchObject({ activeApplicationId: 'builtin.a' })

    runtime.unmount()
    expect(runtime.getSnapshot()).toMatchObject({ activeApplicationId: null })
    expect(listener).toHaveBeenCalledTimes(3)
  })

  it('重复挂载当前 Application 不发布无效更新', () => {
    const runtime = createApplicationRuntime()
    runtime.registerBuiltin({ id: 'builtin.a', component: ApplicationA })
    const listener = vi.fn()
    runtime.subscribe(listener)

    runtime.mount('builtin.a')
    runtime.mount('builtin.a')

    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('拒绝挂载未注册 Application 和重复 id', () => {
    const runtime = createApplicationRuntime()
    runtime.registerBuiltin({ id: 'builtin.a', component: ApplicationA })

    expect(() => runtime.mount('missing')).toThrow('未注册')
    expect(() => runtime.registerBuiltin({ id: 'builtin.a', component: ApplicationB })).toThrow('已注册')
  })

  it('注销 active Application 时自动进入恢复态', () => {
    const runtime = createApplicationRuntime()
    const registration = runtime.registerBuiltin({ id: 'builtin.a', component: ApplicationA })
    runtime.mount('builtin.a')

    registration.dispose()

    expect(runtime.getSnapshot().activeApplicationId).toBeNull()
    expect(runtime.resolve('builtin.a')).toBeNull()
  })

  it('shadow transaction 原子替换同 id Application，并可精确 revert', () => {
    const runtime = createApplicationRuntime()
    const oldOwner = createPluginIdentity('builtin.shell', 'old')
    const nextOwner = createPluginIdentity('builtin.shell', 'next')
    runtime.register(oldOwner, { id: 'builtin.shell', component: ApplicationA })
    runtime.mount('builtin.shell')

    const transaction = runtime.beginShadowTransaction(nextOwner, oldOwner.key)
    transaction.register({ id: 'builtin.shell', component: ApplicationB })
    expect(runtime.resolve('builtin.shell')?.component).toBe(ApplicationA)

    transaction.validate()
    transaction.commit()
    expect(runtime.resolve('builtin.shell')?.component).toBe(ApplicationB)
    expect(runtime.getSnapshot().activeApplicationId).toBe('builtin.shell')

    transaction.revert()
    expect(runtime.resolve('builtin.shell')?.component).toBe(ApplicationA)
    expect(runtime.getSnapshot().activeApplicationId).toBe('builtin.shell')
  })
})
