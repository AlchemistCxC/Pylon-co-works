import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ViteDevServer, Connect } from 'vite'
import { browserPreviewProxy } from '../vite.config.ts'

afterEach(() => vi.unstubAllGlobals())

async function request(url: string) {
  let handler!: Connect.NextHandleFunction
  const configure = browserPreviewProxy().configureServer as (server: ViteDevServer) => void
  configure({ middlewares: { use: (_path: string, value: Connect.NextHandleFunction) => { handler = value } } } as ViteDevServer)
  const response = { statusCode: 200, setHeader: vi.fn(), end: vi.fn() }
  const next = vi.fn()
  await handler({ url } as Parameters<typeof handler>[0], response as unknown as Parameters<typeof handler>[1], next)
  return { response, next }
}

describe('#49 browser preview request isolation', () => {
  it('returns 502 on connection failure without entering Vite error middleware', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')))
    const { response, next } = await request('/?url=http%3A%2F%2F127.0.0.1%3A59999%2F')
    expect(response.statusCode).toBe(502)
    expect(response.setHeader).toHaveBeenCalledWith('content-type', 'text/plain; charset=utf-8')
    expect(response.end).toHaveBeenCalledWith(expect.stringContaining('could not load'))
    expect(next).not.toHaveBeenCalled()
  })

  it('preserves upstream non-HTML status and bytes', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('not found', { status: 404 })))
    const { response } = await request('/?url=https%3A%2F%2Fexample.com')
    expect(response.statusCode).toBe(404)
    expect(response.end).toHaveBeenCalledWith(new TextEncoder().encode('not found'))
  })

  it('keeps the navigation bridge for successful HTML', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<head></head><body>Page</body>', { headers: { 'content-type': 'text/html' } })))
    const { response } = await request('/?url=https%3A%2F%2Fexample.com%2F')
    expect(response.end).toHaveBeenCalledWith(expect.stringContaining('<base href="https://example.com/">'))
    expect(response.end).toHaveBeenCalledWith(expect.stringContaining('pylon-browser-preview'))
  })
})
