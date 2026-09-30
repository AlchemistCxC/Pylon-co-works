import { Suspense, lazy, type ComponentType } from 'react'
import { BUILTIN_TACTICAL_SCENE_SURFACE_ID } from '../plugins/core/interfaceMode/builtinInterfaceModes.ts'

/**
 * 宿主侧装饰场景注册表（surfaceId → 场景组件）——A-V9 的 view 侧真值。
 * `InterfaceModeContribution.sceneSurface` 只携带 surfaceId，App 按本表解析挂载；
 * 任何模式（内置或插件贡献）声明已登记的 surfaceId 即获得等价装饰层。
 * 场景组件为纯装饰平面（不拦截点击、不承载操作件），按需懒加载。
 */
const INTERFACE_MODE_SCENES: Readonly<Record<string, ComponentType>> = {
  [BUILTIN_TACTICAL_SCENE_SURFACE_ID]: lazy(() => import('./TacticalScene')),
}

export function resolveInterfaceModeScene(surfaceId: string): ComponentType | undefined {
  return INTERFACE_MODE_SCENES[surfaceId]
}

/** 未登记的 surfaceId 静默不渲染（与 shellSurface 的 resolve-or-skip 口径一致）。 */
export function InterfaceModeSceneHost({ surfaceId }: { readonly surfaceId: string }) {
  const Scene = resolveInterfaceModeScene(surfaceId)
  if (!Scene) return null
  return (
    <Suspense fallback={null}>
      <Scene />
    </Suspense>
  )
}
