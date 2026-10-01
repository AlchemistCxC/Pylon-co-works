import { Suspense, lazy, createMemo, type Component } from 'solid-js'
import { Dynamic } from 'solid-js/web'
import { Show } from 'solid-js'
import { createSolidMount } from '../host/solidBridge.solid'
import { BUILTIN_TACTICAL_SCENE_SURFACE_ID } from '../plugins/core/interfaceMode/builtinInterfaceModes.ts'

/**
 * 宿主侧装饰场景注册表（surfaceId → 场景组件）——A-V9 的 view 侧真值。
 * `InterfaceModeContribution.sceneSurface` 只携带 surfaceId，App 按本表解析挂载；
 * 任何模式（内置或插件贡献）声明已登记的 surfaceId 即获得等价装饰层。
 * 场景组件为纯装饰平面（不拦截点击、不承载操作件），按需懒加载。
 * #515：实体自 React 版迁移；场景实体是 TacticalScene.solid.tsx，React 世界经
 * interfaceModeScenes.tsx 薄桥消费本文件。
 */
const INTERFACE_MODE_SCENES: Readonly<Record<string, () => Promise<{ default: Component }>>> = {
  [BUILTIN_TACTICAL_SCENE_SURFACE_ID]: () => import('./TacticalScene.solid.tsx'),
}

// lazy 组件按 surfaceId 缓存——同一 surfaceId 反复解析返回同一实例，避免无谓重挂。
const RESOLVED_SCENES = new Map<string, Component>()

export function resolveInterfaceModeScene(surfaceId: string): Component | undefined {
  const resolved = RESOLVED_SCENES.get(surfaceId)
  if (resolved) return resolved
  const loader = INTERFACE_MODE_SCENES[surfaceId]
  if (!loader) return undefined
  const scene = lazy(loader)
  RESOLVED_SCENES.set(surfaceId, scene)
  return scene
}

/** 未登记的 surfaceId 静默不渲染（与 shellSurface 的 resolve-or-skip 口径一致）。 */
export function InterfaceModeSceneHost(props: { readonly surfaceId: string }) {
  const Scene = createMemo(() => resolveInterfaceModeScene(props.surfaceId))
  return (
    <Suspense fallback={null}>
      <Show when={Scene()}>{scene => <Dynamic component={scene()} />}</Show>
    </Suspense>
  )
}

/** React 薄桥（interfaceModeScenes.tsx）的挂载工厂：Solid JSX 只允许出现在本文件。 */
export const mountInterfaceModeSceneHost = createSolidMount(InterfaceModeSceneHost)
