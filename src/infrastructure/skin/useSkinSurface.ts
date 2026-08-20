/**
 * useSkinSurface — 通过 useSyncExternalStore 订阅 SkinRuntime，并把 resolved skin
 * 投影到真实 DOM surface。React 不依赖设置页手动刷新，也不直写 Store。
 */
import { useCallback, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import type { SkinResolutionContext } from '../../plugin-runtime/skin/skinRuntime.ts'
import type { SkinResolveOptions } from '../../plugin-runtime/skin/skinResolver.ts'
import type { SkinTarget } from '../../plugin-runtime/skin/skinTypes.ts'
import { projectSkinSurface } from './skinProjection.ts'
import { getSkinRuntime } from './skinRuntimeServices.ts'

export function useSkinSurface<T extends HTMLElement = HTMLElement>(
  surface: string,
  target: SkinTarget,
  context: SkinResolutionContext = {},
  options?: SkinResolveOptions,
) {
  const runtime = getSkinRuntime()
  const subscribe = useCallback((listener: () => void) => runtime.subscribe(listener), [runtime])
  const snapshot = useSyncExternalStore(
    subscribe,
    () => runtime.getSnapshot(),
    () => runtime.getSnapshot(),
  )

  const targetKey = `${target.scope}:${target.scope === 'global' ? '' : target.scope === 'workspace' ? target.workspaceId : target.scope === 'agent' ? target.agentId : target.sessionId}`
  const contextKey = `${context.workspaceId ?? ''}\u0000${context.agentId ?? ''}\u0000${context.sessionId ?? ''}`

  const resolved = useMemo(
    () => runtime.resolveSkin(target, context, options),
    // snapshot.revision 驱动皮肤重解析；布局 options 也必须进入依赖，避免左栏折叠时
    // CSS variables 仍停留在旧的 TitleBar 轨道宽度。
    [runtime, targetKey, contextKey, snapshot.revision, options],
  )

  const ref = useRef<T | null>(null)
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    return projectSkinSurface(element, surface, resolved)
  }, [surface, resolved])

  return { ref, resolved, snapshot }
}
