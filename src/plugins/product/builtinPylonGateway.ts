import { createElement, lazy, Suspense, type ComponentType, type LazyExoticComponent } from 'react'
import type { BuiltinPluginDefinition } from '../../plugin-runtime/pluginRuntime.ts'
import type { WorkspaceTypeDefinition, WorkspaceViewProps } from '../../workspace-sheets/workspaceTypes.ts'
import { BUILTIN_PYLON_GATEWAY_ID } from './productPluginIds.ts'
import { mountFirstPartyStyleAssets } from './firstPartyStyleRuntime.ts'
import { loadBuiltinPylonGatewayStyles } from './packages/builtin.pylon-gateway/styleAssets.ts'

const GatewaySheetView = lazy(() => import('../../sheets/gateway/GatewaySheetView.tsx'))

const loadingFallback = createElement(
  'div',
  { className: 'sheet-empty-host' },
  createElement('div', { className: 'sheet-empty-kicker' }, 'LOADING'),
  createElement('p', null, '加载模块…'),
)

function lazyWorkspace(
  Component: LazyExoticComponent<ComponentType<{ sheet: WorkspaceViewProps['sheet']; ctx: WorkspaceViewProps['ctx'] }>>,
): ComponentType<WorkspaceViewProps> {
  return function WorkspaceComponent({ sheet, ctx }) {
    return createElement(
      Suspense,
      { fallback: loadingFallback },
      createElement(Component, { sheet, ctx }),
    )
  }
}

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
  component: lazyWorkspace(GatewaySheetView),
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
