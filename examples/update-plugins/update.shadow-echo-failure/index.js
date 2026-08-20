export async function activate(context) {
  context.commands.register({
    id: 'update.shadow-echo.version',
    name: 'shadow-echo-version',
    description: 'This contribution must never become visible.',
    priority: 100,
    execute: () => 'broken',
  })
  const service = await context.process.spawn('echo', {
    protocol: 'json-rpc',
    shutdown: { method: 'json-rpc', timeoutMs: 2000 },
  })
  await service.request('echo', { version: 'failure-candidate' })
  throw new Error('intentional candidate readiness failure')
}
