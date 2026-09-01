// @vitest-environment jsdom
// SDK 测试基建：createMockContext —— 记录式 mock + 真实 Scope 回收纪律。
import { describe, expect, it } from 'vitest'
import { definePlugin, createSettingsSurface } from '../index.ts'
import { createMockContext } from '../testing.ts'
import type { HookName } from '../../plugin-runtime/hooks/hookTypes.ts'

describe('createMockContext', () => {
  it('activate 记录命令并可通过 __commands.execute 调用', async () => {
    const ctx = createMockContext({ pluginId: 'mock.a' })
    const module = definePlugin({
      async activate(context) {
        context.commands.register({
          id: 'mock.a.ping',
          name: 'mock-ping',
          description: 'ping',
          priority: 100,
          execute: ({ args }) => ({ pong: true, name: (args as { name?: string }).name }),
        })
      },
    })
    await module.activate(ctx)
    const result = await ctx.__commands.execute('mock.a.ping', { name: 'Pylon' })
    expect(result).toEqual({ pong: true, name: 'Pylon' })
    await expect(ctx.__commands.execute('mock.a.missing')).rejects.toThrow(/未注册/)
  })

  it('hook dispatch 按 priority 顺序执行 pipeline 并透传事件', async () => {
    const ctx = createMockContext()
    const module = definePlugin({
      async activate(context) {
        context.hooks.register('message.user.beforeSend' satisfies HookName, {
          id: 'low',
          mode: 'pipeline',
          priority: 10,
          handler: ({ event }) => ({ action: 'continue', event }),
        })
        context.hooks.register('message.user.beforeSend' satisfies HookName, {
          id: 'high',
          mode: 'pipeline',
          priority: 200,
          handler: ({ event }) => ({
            action: 'continue',
            event: { ...(event as Record<string, unknown>), decorated: true },
          }),
        })
      },
    })
    await module.activate(ctx)
    const result = await ctx.__hooks.dispatch('message.user.beforeSend', { text: 'hi' })
    expect(result.executed).toBe(2)
    expect(result.event).toEqual({ text: 'hi', decorated: true })
  })

  it('sessions/turns 为内存实现；未 ensure 的 turn 拒绝写入', async () => {
    const ctx = createMockContext()
    expect(ctx.sessions.setPluginMetadata('s1', { a: 1 })).toBe(true)
    expect(ctx.sessions.getPluginMetadata('s1')).toEqual({ a: 1 })
    expect(ctx.turns.ensure({ id: 't1', sessionId: 's1', startedAt: 1 })).toBe(true)
    expect(ctx.turns.setPluginMetadata('t1', { tokens: 5 })).toBe(true)
    expect(ctx.turns.setPluginMetadata('t-missing', {})).toBe(false)
  })

  it('storage 与 session 嵌套值按副本隔离', async () => {
    const ctx = createMockContext({ storageValues: { cfg: { nested: ['x'] } } })
    const storageValue = ctx.storage.getValue<{ nested: string[] }>('cfg')!
    storageValue.nested.push('mutated')
    expect(ctx.storage.getValue<{ nested: string[] }>('cfg')).toEqual({ nested: ['x'] })
    expect(ctx.__storage.changeCount()).toBe(0)

    ctx.sessions.setPluginMetadata('s1', { nested: { value: 1 } })
    const metadata = ctx.sessions.getPluginMetadata('s1')
    ;(metadata.nested as { value: number }).value = 2
    expect(ctx.sessions.getPluginMetadata('s1')).toEqual({ nested: { value: 1 } })
  })

  it('未实现 API 调用可从 __recorded 读取', async () => {
    const ctx = createMockContext()
    ;(ctx as unknown as { fonts: { register(value: unknown): void } }).fonts.register({ family: 'mock' })
    expect(ctx.__recorded).toEqual([{ member: 'fonts', method: 'register', args: [{ family: 'mock' }] }])
  })

  it('settings 驱动隔离 surface；host:input 回流渲染、控件提交 settings:set', async () => {
    const ctx = createMockContext({ settingsValues: { greetingName: 'Pylon', decorate: true } })
    const module = definePlugin({
      async activate(context) {
        context.settings.registerPage({
          id: 'mock.a.page',
          label: 'Mock 设置',
          renderKind: 'isolated-surface',
          surfaceId: 'mock.a.surface',
        })
        context.ui.registerSurface(
          createSettingsSurface({
            id: 'mock.a.surface',
            fields: [
              { key: 'greetingName', type: 'text', label: '问候名' },
              { key: 'decorate', type: 'toggle', label: '装饰' },
            ],
          }),
        )
      },
    })
    await module.activate(ctx)

    const driver = ctx.__ui.mount('mock.a.surface')
    const text = driver.container.querySelector('input[type="text"]') as HTMLInputElement
    expect(text.value).toBe('Pylon')

    driver.hostInput({ greetingName: '新值', decorate: false })
    expect((driver.container.querySelector('input[type="text"]') as HTMLInputElement).value).toBe('新值')

    const box = driver.container.querySelector('input[type="checkbox"]') as HTMLInputElement
    box.checked = true
    box.dispatchEvent(new Event('change'))
    expect(driver.events.at(-1)).toEqual({ event: 'settings:set', detail: { key: 'decorate', value: true } })
    expect(ctx.__settings.values.decorate).toBe(true)

    await driver.unmount()
    expect(driver.container.childElementCount).toBe(0)
  })

  it('scope dispose 回收插件登记的资源（真实 Scope 纪律）', async () => {
    const ctx = createMockContext()
    let disposed = 0
    const module = definePlugin({
      async activate(context) {
        context.scope.listen(
          { addEventListener() {}, removeEventListener() { disposed += 1 }, dispatchEvent() { return true } },
          'click',
          () => {},
        )
        context.scope.setTimeout(() => {}, 10_000)
      },
    })
    await module.activate(ctx)
    expect(ctx.scope.size).toBeGreaterThan(0)
    await ctx.__scopeDispose()
    expect(disposed).toBe(1)
    expect(ctx.scope.isDisposed).toBe(true)
  })

  it('异步 UI surface mount 的 disposer 也能通过测试 driver 回收', async () => {
    const ctx = createMockContext()
    let disposed = 0
    const module = definePlugin({
      activate(context) {
        context.ui.registerSurface({
          id: 'mock.a.async-surface',
          mount: async () => ({ unmount() { disposed += 1 } }),
        })
      },
    })
    await module.activate(ctx)
    const driver = ctx.__ui.mount('mock.a.async-surface')
    await driver.unmount()
    expect(disposed).toBe(1)
  })

  it('未实现的 API 面以记录代理兜底（调用被记录而非崩溃）', async () => {
    const ctx = createMockContext()
    await module_activate_and_call(ctx)
  })

  async function module_activate_and_call(ctx: ReturnType<typeof createMockContext>): Promise<void> {
    const module = definePlugin({
      async activate(context) {
        ;(context as unknown as { fonts: Record<string, (...args: unknown[]) => unknown> }).fonts.register?.({})
      },
    })
    await module.activate(ctx)
  }
})
