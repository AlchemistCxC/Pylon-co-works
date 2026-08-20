import { describe, expect, it } from 'vitest'
import { advanceSourceContext, beginSourceRequest, isCurrentSourceRequest } from '../sourceRequestGuard'

describe('FileSheet source request guard', () => {
  it('rejects responses from an older source generation', () => {
    const first = advanceSourceContext({ source: null, generation: 0 }, 'workspace-a')
    const token = beginSourceRequest(first, 'workspace-a')
    const next = advanceSourceContext(first, 'workspace-b')

    expect(isCurrentSourceRequest(first, token)).toBe(true)
    expect(isCurrentSourceRequest(next, token)).toBe(false)
  })

  it('rejects responses after disposal/source clearing', () => {
    const active = advanceSourceContext({ source: null, generation: 0 }, 'workspace-a')
    const token = beginSourceRequest(active, 'workspace-a')
    const disposed = advanceSourceContext(active, null)

    expect(isCurrentSourceRequest(disposed, token)).toBe(false)
  })
})
