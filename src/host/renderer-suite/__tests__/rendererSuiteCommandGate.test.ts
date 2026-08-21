import { describe, expect, it } from 'vitest'
import { createRendererSuiteCommandGate } from '../rendererSuiteCommandGate.ts'

describe('RendererSuiteCommandGate', () => {
  it('rejects candidate commands until activated and delegates afterward', async () => {
    const gate = createRendererSuiteCommandGate()
    const delegate = { prompt: async () => ({ ok: true as const, value: { status: 'sent' as const } }) }
    const port = gate.bind(delegate as never)
    expect(await port.prompt('s1', { text: 'hello' })).toMatchObject({ ok: false, error: { code: 'renderer_not_active' } })
    gate.activate()
    expect(await port.prompt('s1', { text: 'hello' })).toMatchObject({ ok: true, value: { status: 'sent' } })
  })
})
