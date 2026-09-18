import { describe, expect, it } from 'vitest'
import { createRendererSuiteCommandGate } from '../rendererSuiteCommandGate.ts'

const PORT_METHODS = [
  'prompt', 'send', 'cancel', 'attach', 'setModel', 'setMode', 'createSession', 'compact', 'exportSession', 'clearSession',
  'setConfigOption', 'toolAction', 'respondInteraction', 'openResource', 'revealResource', 'copy', 'retry', 'recover',
] as const

describe('RendererSuiteCommandGate', () => {
  it('rejects candidate commands until activated and delegates afterward', async () => {
    const gate = createRendererSuiteCommandGate()
    const delegate = { prompt: async () => ({ ok: true as const, value: { status: 'sent' as const } }) }
    const port = gate.bind(delegate as never)
    expect(await port.prompt('s1', { text: 'hello' })).toMatchObject({ ok: false, error: { code: 'renderer_not_active' } })
    gate.activate()
    expect(await port.prompt('s1', { text: 'hello' })).toMatchObject({ ok: true, value: { status: 'sent' } })
  })

  // 白名单必须覆盖 WorkbenchCommandPort 的每一个方法：漏一个，该方法在 bind() 出来的
  // port 上就是 undefined，控件点击会抛 `... is not a function`，命令根本发不出去。
  it('binds every WorkbenchCommandPort method and forwards it to the delegate', async () => {
    const gate = createRendererSuiteCommandGate()
    const calls: string[] = []
    const delegate = Object.fromEntries(PORT_METHODS.map(name => [name, async () => {
      calls.push(name)
      return { ok: true as const, value: name }
    }]))
    const port = gate.bind(delegate as never)

    expect(PORT_METHODS).toHaveLength(18)
    for (const name of PORT_METHODS) expect(typeof port[name]).toBe('function')

    gate.activate()
    for (const name of PORT_METHODS) {
      await (port[name] as (...args: readonly unknown[]) => Promise<unknown>)('s1')
    }
    expect(calls).toEqual([...PORT_METHODS])
  })
})
