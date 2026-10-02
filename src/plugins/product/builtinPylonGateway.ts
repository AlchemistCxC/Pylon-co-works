import { lazy, type Component } from 'solid-js'
import type { BuiltinPluginDefinition } from '../../plugin-runtime/pluginRuntime.ts'
import type { WorkspaceTypeDefinition, WorkspaceViewProps } from '../../plugin-runtime/workspaces/workspaceTypes.ts'
import { BUILTIN_PYLON_GATEWAY_ID } from './productPluginIds.ts'
import { mountFirstPartyStyleAssets } from './firstPartyStyleRuntime.ts'
import { loadBuiltinPylonGatewayStyles } from './packages/builtin.pylon-gateway/styleAssets.ts'

// #515 贡献面翻转：workspace 渲染面是 Solid 实体（此前注册 React 薄桥）。本文件留在
// React 类型图（.ts），不得静态 import .solid 文件——按 P52 D4 经 glob 缝（运行期模块
// 解析，零类型图边）加载，solid `lazy` 保留代码分割；Suspense 由宿主侧（SheetHost）承担。
interface GatewaySheetViewSolidModule { default: Component<WorkspaceViewProps> }

const solidLoaders = import.meta.glob<GatewaySheetViewSolidModule>('../../sheets/gateway/GatewaySheetView.solid.tsx')

const GatewaySheetView = lazy(() => {
  const load = solidLoaders['../../sheets/gateway/GatewaySheetView.solid.tsx']
  if (!load) return Promise.reject(new Error('GatewaySheetView Solid 实体未进入 Vite module graph'))
  return load()
})

const emptyState = () => undefined
const serializeEmptyState = () => undefined
const deserializeEmptyState = () => undefined
const singleton = (key: string) => () => key

/**
 * Gateway 工作区类型（P77 自 core/sheet BUILTIN_WORKSPACE_TYPES 原样搬移）：
 * kind 字符串、launch 元数据与 singleton 语义是持久化/入口契约，禁止漂移。
 */
const GATEWAY_WORKSPACE_TYPE: WorkspaceTypeDefinition<unknown> = Object.freeze({
  kind: 'gateway',
  label: 'Gateway',
  singleton: true,
  getSingletonKey: singleton('gateway'),
  sidebarMode: 'sheet',
  component: GatewaySheetView,
  launch: { kind: 'gateway', title: 'Gateway', description: '网关适配器与路由概览', launchable: true, icon: 'waypoints', category: 'system', categoryLabel: '系统与管理', categoryOrder: 30, order: 20, keywords: ['route', 'adapter', '网关', '路由', '适配器'] },
  createInitialState: emptyState,
  serialize: serializeEmptyState,
  deserialize: deserializeEmptyState,
})

export function createBuiltinPylonGatewayPlugin(): BuiltinPluginDefinition {
  return {
    id: BUILTIN_PYLON_GATEWAY_ID,
    kind: 'workspace',
    firstParty: true,
    hotSwapMode: 'parallel',
    activate: context => {
      mountFirstPartyStyleAssets(BUILTIN_PYLON_GATEWAY_ID, context.identity.key, context.scope, loadBuiltinPylonGatewayStyles())
      context.workspace.registerType(GATEWAY_WORKSPACE_TYPE)
    },
  }
}
