/**
 * createSkinSurface — useSkinSurface 的 Solid 等价形态（#515，供根翻转后的 Solid App 根消费）。
 *
 * 与 React 版（useSkinSurface.ts）逐项对齐：
 * - 经 SkinRuntime.subscribe 订阅快照（不依赖设置页手动刷新，也不直写 Store）；
 * - resolved skin 由 resolveSkin 派生，snapshot.revision 变化驱动重解析（对齐 React 版
 *   deps 里的 snapshot.revision；布局 options 同样进入追踪，避免左栏折叠时 CSS variables
 *   停留在旧的 TitleBar 轨道宽度）；
 * - ref 挂上真实 DOM surface 后由 projectSkinSurface 投影，dispose 随作用域回收。
 *
 * React 版保留给现役 React 根（App.tsx）；根翻转后本文件是唯一形态，React 版随批7 删除。
 */
import { createEffect, createMemo, createSignal, onCleanup } from 'solid-js'
import type { SkinResolutionContext } from '../../plugin-runtime/skin/skinRuntime.ts'
import type { ResolvedSkin, SkinRuntimeSnapshot } from '../../plugin-runtime/skin/skinTypes.ts'
import type { SkinResolveOptions } from '../../plugin-runtime/skin/skinResolver.ts'
import type { SkinTarget } from '../../plugin-runtime/skin/skinTypes.ts'
import { projectSkinSurface } from './skinProjection.ts'
import { getSkinRuntime } from './skinRuntimeServices.ts'

/** 值或访问器统一成访问器：调用方既可传静态值，也可传信号读取保持响应性。 */
function toGetter<T>(value: T | (() => T)): () => T {
  return typeof value === 'function' ? value as () => T : () => value
}

export interface SkinSurfaceBinding<T extends HTMLElement = HTMLElement> {
  /** 挂到目标 surface 元素上的 ref（`ref={binding.ref}`）。 */
  ref: (element: T) => void
  resolved: () => ResolvedSkin
  snapshot: () => SkinRuntimeSnapshot
}

export function createSkinSurface<T extends HTMLElement = HTMLElement>(
  surface: string | (() => string),
  target: SkinTarget | (() => SkinTarget),
  context: SkinResolutionContext | (() => SkinResolutionContext) = {},
  options?: SkinResolveOptions | (() => SkinResolveOptions | undefined),
): SkinSurfaceBinding<T> {
  const runtime = getSkinRuntime()
  const [snapshot, setSnapshot] = createSignal<SkinRuntimeSnapshot>(runtime.getSnapshot())
  onCleanup(runtime.subscribe(() => setSnapshot(() => runtime.getSnapshot())))

  const getSurface = toGetter(surface)
  const getTarget = toGetter(target)
  const getContext = toGetter(context)
  const getOptions = toGetter(options ?? (undefined as SkinResolveOptions | undefined))

  const resolved = createMemo(() => {
    // snapshot.revision 驱动皮肤重解析（与 React 版 deps 语义一致）。
    void snapshot().revision
    return runtime.resolveSkin(getTarget(), getContext(), getOptions() ?? {})
  })

  const ref = (element: T) => {
    createEffect(() => {
      const disposeProjection = projectSkinSurface(element, getSurface(), resolved())
      onCleanup(disposeProjection)
    })
  }

  return { ref, resolved, snapshot }
}
