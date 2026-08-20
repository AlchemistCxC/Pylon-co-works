export async function activate(context) {
  const service = await context.process.spawn('echo', {
    protocol: 'json-rpc',
    restart: { policy: 'on-failure', maxAttempts: 2, backoffMs: 250 },
    shutdown: { method: 'json-rpc', timeoutMs: 2000 },
  })
  const response = await service.request('echo', { ready: true })
  if (!response?.ready) throw new Error('JSON-RPC echo readiness failed')
}
