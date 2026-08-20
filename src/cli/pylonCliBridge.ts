import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { IS_TAURI } from '../infrastructure/tauri/env.ts'
import { getPylonCliService, getPylonCliTool } from './pylonCliRuntime.ts'

interface CliFrontendRequest {
  requestId: string
  command: string
  args: Record<string, unknown>
  timeoutMs: number
}

interface CliFrontendCancel {
  requestId: string
}

let installation: Promise<() => void> | undefined

export function installPylonCliBridge(): Promise<() => void> {
  if (!IS_TAURI) return Promise.resolve(() => undefined)
  installation ??= install()
  return installation
}

async function install(): Promise<() => void> {
  const controllers = new Map<string, AbortController>()
  const unlistenRequest = await listen<CliFrontendRequest>('pylon:cli-request', event => {
    const request = event.payload
    const controller = new AbortController()
    controllers.set(request.requestId, controller)
    void getPylonCliService().execute({
      command: request.command,
      args: request.args,
      timeoutMs: request.timeoutMs,
    }, { signal: controller.signal }).then(
      result => invoke('pylon_cli_respond', { requestId: request.requestId, result }),
      error => invoke('pylon_cli_respond', {
        requestId: request.requestId,
        error: error instanceof Error ? error.message : String(error),
      }),
    ).catch(error => console.error('Pylon CLI response failed', error))
      .finally(() => controllers.delete(request.requestId))
  })
  const unlistenCancel = await listen<CliFrontendCancel>('pylon:cli-cancel', event => {
    controllers.get(event.payload.requestId)?.abort(new DOMException('CLI request cancelled', 'AbortError'))
  })
  window.__PYLON_CLI_TOOL__ = getPylonCliTool()
  await invoke('pylon_cli_ready')
  return () => {
    unlistenRequest()
    unlistenCancel()
    for (const controller of controllers.values()) controller.abort()
    controllers.clear()
    delete window.__PYLON_CLI_TOOL__
    installation = undefined
  }
}

declare global {
  interface Window {
    /** Single structured Agent Tool required by D-009. */
    __PYLON_CLI_TOOL__?: ReturnType<typeof getPylonCliTool>
  }
}
