export async function activate(context) {
  context.commands.register({
    id: 'update.shadow-echo.version',
    name: 'shadow-echo-version',
    description: 'Reports the active Shadow Echo version.',
    priority: 100,
    execute: () => 'v2',
  })
  const service = await context.process.spawn('echo', {
    protocol: 'json-rpc',
    shutdown: { method: 'json-rpc', timeoutMs: 2000 },
  })
  const ready = await service.request('echo', { version: 'v2' })
  if (ready?.version !== 'v2') throw new Error('v2 readiness failed')
}
