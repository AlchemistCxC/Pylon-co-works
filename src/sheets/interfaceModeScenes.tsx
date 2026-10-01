import { lazy, type ComponentType } from 'react'
import SolidMount from '../host/SolidMount'

/**
 * 宿主侧装饰场景注册表（surfaceId → 场景组件）——A-V9 的 view 侧真值。
 * `InterfaceModeContribution.sceneSurface` 只携带 surfaceId，App 按本表解析挂载；
 * 任何模式（内置或插件贡献）声明已登记的 surfaceId 即获得等价装饰层。
 * 场景组件为纯装饰平面（不拦截点击、不承载操作件），按需懒加载。
 *
 * #515：实体在 interfaceModeScenes.solid.tsx，本文件是 React 世界薄桥（批7 拆除）。
 * 场景登记的真值在 Solid 实体的注册表；本文件的 resolveInterfaceModeScene 经实体
 * 注册表判存（单一事实源），React lazy 只承载 TacticalScene 的 React 薄桥。
 */

/** Solid 实体的模块接口（React 类型图内的唯一事实）。 */
interface InterfaceModeScenesSolidModule {
  mountInterfaceModeSceneHost(container: HTMLElement, latest: () => { surfaceId: string }): () => void
  resolveInterfaceModeScene(surfaceId: string): unknown
}

const modules = import.meta.glob<InterfaceModeScenesSolidModule>('./interfaceModeScenes.solid.tsx', { eager: true })
const solidModule = modules['./interfaceModeScenes.solid.tsx']
if (!solidModule) throw new Error('InterfaceModeScenes Solid 实体未进入 Vite module graph')

export function resolveInterfaceModeScene(surfaceId: string): ComponentType | undefined {
  return solidModule.resolveInterfaceModeScene(surfaceId) ? lazy(() => import('./TacticalScene')) : undefined
}

/** 未登记的 surfaceId 静默不渲染（与 shellSurface 的 resolve-or-skip 口径一致）。 */
export function InterfaceModeSceneHost({ surfaceId }: { readonly surfaceId: string }) {
  return <SolidMount initial={{ surfaceId }} mount={(container, latest) => solidModule.mountInterfaceModeSceneHost(container, latest)} />
}
