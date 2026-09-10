/**
 * P55-D1：kernel hook bridge dispatcher（模式抄 src/cli/pylonCliBridge.ts）。
 *
 * Rust 锚点缝（prompt.rs 发送链 / lib.rs 平台入站）emit `pylon:hook-request`
 * → 本 dispatcher 常驻监听 → `HookRuntime.invoke`（kernel 域显式 opt-in）→
 * `pylon_hook_respond` 回程 → Rust oneshot 唤醒。
 *
 * fail-closed 语义（kernel 域专属，勿动 GUI/CLI 域"空=全放行"语义）：
 * 会话不存在 / session.hooks 为空 / 锚点名不在词表 → 直接回 continue，**不进
 * HookRuntime**——kernel 钩子只有会话显式 opt-in（hooks 列出插件 id）才执行。
 *
 * ready 简化取舍（首版）：安装即 `pylon_hook_ready`，未做 KernelBootstrap ready +
 * sessionsHydrated 前置；hydration 前的极早期派发由 dispatcher 层 fail-closed
 * 兜底（sessions 未水合 → resolveSession 落空 → continue）。D2+ 若需更严的
 * ready 门槛，在此处补订阅即可，Rust 侧契约不变。
 */
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { IS_TAURI } from '../tauri/env.ts'
import { useIdentityStore } from '../../identityStore.ts'
import { getHookRuntime } from '../../plugin-runtime/runtimeServices.ts'
import { HOOK_NAMES, type HookInvocationResult, type HookName } from '../../plugin-runtime/hooks/hookTypes.ts'

interface HookFrontendRequest {
  requestId: string
  hook: string
  sessionId: string
  payload: Record<string, unknown>
  timeoutMs: number
}

interface HookFrontendCancel {
  requestId: string
}

/** 词表校验集：Rust 送来的锚点名必须在前端 HOOK_NAMES 内（防 wire 漂移）。 */
const KNOWN_HOOK_NAMES: ReadonlySet<string> = new Set(HOOK_NAMES)

function resolveSession(sessionId: string) {
  return useIdentityStore.getState().sessions.find(session => session.id === sessionId || session.source === sessionId)
}

/** fail-closed 应答：不执行任何 handler，原样放行。 */
function passThroughResult(payload: Record<string, unknown>): HookInvocationResult<Record<string, unknown>> {
  return { action: 'continue', event: payload, executed: 0, skipped: 0 }
}

async function executeHook(
  request: HookFrontendRequest,
  signal: AbortSignal,
): Promise<HookInvocationResult<Record<string, unknown>>> {
  const hookName = KNOWN_HOOK_NAMES.has(request.hook) ? (request.hook as HookName) : undefined
  if (!hookName) {
    console.warn(`Pylon hook bridge received unknown anchor: ${request.hook}`)
    return passThroughResult(request.payload)
  }
  const session = resolveSession(request.sessionId)
  // kernel 域显式 opt-in：会话不存在或 hooks 空 → 不进 HookRuntime（fail-closed）。
  if (!session || (session.hooks?.length ?? 0) === 0) {
    return passThroughResult(request.payload)
  }
  return getHookRuntime().invoke(hookName, request.payload, session.hooks, signal)
}

/** 前端钩子面 → Rust registry 闸（零注册 = 零派发；D4 扩展为 manifest join）。 */
async function syncHookRegistry(): Promise<void> {
  const hooks = [...new Set(getHookRuntime().registry.getSnapshot().entries.map(entry => entry.value.hookName))]
  await invoke('hook_registry_sync', { payload: { hooks } })
}

let installation: Promise<() => void> | undefined

export function installPylonHookBridge(): Promise<() => void> {
  if (!IS_TAURI) return Promise.resolve(() => undefined)
  installation ??= install()
  return installation
}

async function install(): Promise<() => void> {
  const controllers = new Map<string, AbortController>()
  const unlistenRequest = await listen<HookFrontendRequest>('pylon:hook-request', event => {
    const request = event.payload
    const controller = new AbortController()
    controllers.set(request.requestId, controller)
    void executeHook(request, controller.signal).then(
      result => invoke('pylon_hook_respond', { requestId: request.requestId, result }),
      error => invoke('pylon_hook_respond', {
        requestId: request.requestId,
        error: error instanceof Error ? error.message : String(error),
      }),
    ).catch(error => console.error('Pylon hook response failed', error))
      .finally(() => controllers.delete(request.requestId))
  })
  const unlistenCancel = await listen<HookFrontendCancel>('pylon:hook-cancel', event => {
    controllers.get(event.payload.requestId)?.abort(new DOMException('Kernel hook request cancelled', 'AbortError'))
  })
  // registry 增量同步：插件激活/停用改变钩子面时重推（Rust 侧只对已注册锚点派发）。
  const unsubscribeRegistry = getHookRuntime().registry.subscribe(() => {
    void syncHookRegistry().catch(error => console.error('Pylon hook registry sync failed', error))
  })
  await syncHookRegistry()
  await invoke('pylon_hook_ready')
  return () => {
    unlistenRequest()
    unlistenCancel()
    unsubscribeRegistry()
    for (const controller of controllers.values()) controller.abort()
    controllers.clear()
    installation = undefined
  }
}
