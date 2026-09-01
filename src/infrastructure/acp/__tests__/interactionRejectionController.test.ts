// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { clearErrors, getErrors } from '../../../errorCenter.ts'
import {
  createInteractionRejectionController,
  normalizeInteractionRejection,
} from '../interactionRejectionController.ts'

afterEach(() => clearErrors())

describe('interaction rejection transport', () => {
  it('normalizes camelCase and rejects payloads that could not be explained safely', () => {
    expect(normalizeInteractionRejection({
      provider: 'hermes', agent_id: 'h1', request_id: 'r1', method: 'session/ask',
      reason_code: 'method_unsupported', rpc_code: -32601, response_sent: true,
      message: 'unsupported', params: { secret: 'must not be read' },
    })).toMatchObject({ provider: 'hermes', agentId: 'h1', requestId: 'r1', reasonCode: 'method_unsupported', rpcCode: -32601, responseSent: true })
    expect(normalizeInteractionRejection({ provider: 'hermes', reasonCode: 'x' })).toBeNull()
  })

  it('reports once, fans out a UI event, and disposes the listener', async () => {
    let handler: ((event: { payload: unknown }) => void) | undefined
    const stop = vi.fn()
    const controller = createInteractionRejectionController({
      listen: vi.fn(async (_event, next) => { handler = next; return stop }),
    })
    const listener = vi.fn()
    window.addEventListener('pylon:interaction-rejected', listener)
    await vi.waitFor(() => expect(handler).toBeDefined())
    handler!({ payload: { provider: 'hermes', agentId: 'h1', requestId: 'r1', method: 'session/ask', reasonCode: 'method_unsupported', message: 'unsupported', responseSent: true } })
    expect(listener).toHaveBeenCalledTimes(1)
    expect(getErrors()[0]).toMatchObject({ code: 'interaction_method_unsupported', message: 'unsupported' })
    // duplicate in the debounce window is not surfaced twice
    handler!({ payload: { provider: 'hermes', agentId: 'h1', requestId: 'r1', method: 'session/ask', reasonCode: 'method_unsupported', message: 'unsupported', responseSent: true } })
    expect(listener).toHaveBeenCalledTimes(1)
    await controller.dispose()
    expect(stop).toHaveBeenCalledTimes(1)
    window.removeEventListener('pylon:interaction-rejected', listener)
  })
})

