import { createElement, lazy, Suspense, type ComponentType, type LazyExoticComponent } from 'react'
import type { BuiltinPluginDefinition } from '../../../plugin-runtime/pluginRuntime.ts'
import type { WorkspaceTypeDefinition, WorkspaceViewProps } from '../../../workspace-sheets/workspaceTypes.ts'
import {
  deserializeAgentWorkspaceState,
  serializeAgentWorkspaceState,
} from '../../../workspace-sheets/agentWorkspaceState.ts'

const AgentSheetView = lazy(() => import('../../../sheets/AgentSheetView.tsx'))
const PrismManagerSheetView = lazy(() => import('../../../sheets/PrismManagerSheetView.tsx'))
const RuntimeSheetView = lazy(() => import('../../../sheets/RuntimeSheetView.tsx'))
const FileSheetView = lazy(() => import('../../../sheets/file/FileSheetView.tsx'))
const OverviewSheetView = lazy(() => import('../../../sheets/OverviewSheetView.tsx'))
const SearchSheetView = lazy(() => import('../../../sheets/search/SearchSheetView.tsx'))
const HistorySheetView = lazy(() => import('../../../sheets/history/HistorySheetView.tsx'))
const BrowserSheetView = lazy(() => import('../../../sheets/browser/BrowserSheetView.tsx'))
const GatewaySheetView = lazy(() => import('../../../sheets/gateway/GatewaySheetView.tsx'))
const Sidebar = lazy(() => import('../../../components/Sidebar.tsx'))

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

function lazyPanel(
  Component: LazyExoticComponent<ComponentType<{ sheet: WorkspaceViewProps['sheet']; ctx: WorkspaceViewProps['ctx']; state: unknown }>>,
): ComponentType<WorkspaceViewProps> {
  return function WorkspacePanel({ sheet, ctx, state }) {
    return createElement(Suspense, { fallback: null }, createElement(Component, { sheet, ctx, state }))
  }
}

const emptyState = () => undefined
const serializeEmptyState = () => undefined
const deserializeEmptyState = () => undefined
const singleton = (key: string) => () => key
const agentSingleton: WorkspaceTypeDefinition['getSingletonKey'] = input => input.agentId ? `agent:${input.agentId}` : undefined
const fileSingleton: WorkspaceTypeDefinition['getSingletonKey'] = input => input.singletonKey
function defineWorkspace(
  definition: Omit<WorkspaceTypeDefinition<unknown>, 'createInitialState' | 'serialize' | 'deserialize'>,
): WorkspaceTypeDefinition<unknown> {
  return Object.freeze({
    ...definition,
    createInitialState: emptyState,
    serialize: serializeEmptyState,
    deserialize: deserializeEmptyState,
  })
}

export const BUILTIN_WORKSPACE_TYPES: readonly WorkspaceTypeDefinition<unknown>[] = [
  { kind: 'agent', label: 'Agent', singleton: true, getSingletonKey: agentSingleton, sidebarMode: 'workspace', component: lazyWorkspace(AgentSheetView), sidebar: lazyPanel(Sidebar), createInitialState: deserializeAgentWorkspaceState, serialize: serializeAgentWorkspaceState, deserialize: deserializeAgentWorkspaceState },
  defineWorkspace({ kind: 'prism', label: 'Prism', singleton: true, getSingletonKey: singleton('prism'), sidebarMode: 'sheet', component: lazyWorkspace(PrismManagerSheetView), launch: { kind: 'prism', title: 'Prism', description: '管理实例、Profiles 与扩展', launchable: true, icon: 'boxes', category: 'system', categoryLabel: '系统与管理', categoryOrder: 30, order: 30, keywords: ['manage', 'profile', 'instance'] } }),
  defineWorkspace({ kind: 'runtime', label: 'Runtime', singleton: true, getSingletonKey: singleton('runtime'), sidebarMode: 'sheet', component: lazyWorkspace(RuntimeSheetView), launch: { kind: 'runtime', title: 'Runtime', description: '运行日志与启动诊断', launchable: true, icon: 'activity', category: 'observe', categoryLabel: '观察与诊断', categoryOrder: 20, order: 30, keywords: ['log', 'debug', 'diagnostic'] } }),
  defineWorkspace({ kind: 'file', label: 'File', singleton: false, getSingletonKey: fileSingleton, sidebarMode: 'sheet', component: lazyWorkspace(FileSheetView), launch: { kind: 'file', title: 'File', description: '工作区文件、SCM 与搜索', launchable: true, icon: 'folder-tree', category: 'work', categoryLabel: '工作台', categoryOrder: 10, order: 10, keywords: ['git', 'scm', 'code'] } }),
  defineWorkspace({ kind: 'overview', label: 'Overview', singleton: true, getSingletonKey: singleton('overview'), sidebarMode: 'sheet', component: lazyWorkspace(OverviewSheetView), launch: { kind: 'overview', title: 'Overview', description: '工作状态与最近会话概览', launchable: true, icon: 'layout-dashboard', category: 'observe', categoryLabel: '观察与诊断', categoryOrder: 20, order: 10, keywords: ['dashboard', 'summary'] } }),
  defineWorkspace({ kind: 'search', label: 'Search', singleton: true, getSingletonKey: singleton('search'), sidebarMode: 'sheet', component: lazyWorkspace(SearchSheetView), launch: { kind: 'search', title: 'Search', description: '跨会话快照搜索', launchable: true, icon: 'search', category: 'work', categoryLabel: '工作台', categoryOrder: 10, order: 30, keywords: ['find', 'snapshot'] } }),
  defineWorkspace({ kind: 'history', label: 'History', singleton: true, getSingletonKey: singleton('history'), sidebarMode: 'sheet', component: lazyWorkspace(HistorySheetView), launch: { kind: 'history', title: 'History', description: '存档会话列表与导出', launchable: true, icon: 'history', category: 'observe', categoryLabel: '观察与诊断', categoryOrder: 20, order: 20, keywords: ['archive', 'export'] } }),
  defineWorkspace({ kind: 'browser', label: 'Browser', singleton: true, getSingletonKey: singleton('browser'), sidebarMode: 'sheet', component: lazyWorkspace(BrowserSheetView), launch: { kind: 'browser', title: 'Browser', description: '多标签网页工作区', launchable: true, icon: 'globe', category: 'work', categoryLabel: '工作台', categoryOrder: 10, order: 20, keywords: ['web', 'url'] } }),
  defineWorkspace({ kind: 'gateway', label: 'Gateway', singleton: true, getSingletonKey: singleton('gateway'), sidebarMode: 'sheet', component: lazyWorkspace(GatewaySheetView), launch: { kind: 'gateway', title: 'Gateway', description: '网关适配器与路由概览', launchable: true, icon: 'waypoints', category: 'system', categoryLabel: '系统与管理', categoryOrder: 30, order: 20, keywords: ['route', 'adapter'] } }),
] as const

export function createBuiltinWorkspacePluginDefinitions(): readonly BuiltinPluginDefinition[] {
  return BUILTIN_WORKSPACE_TYPES.map(definition => ({
    id: `core.sheet.${definition.kind}`,
    activate: ({ workspace }) => {
      workspace.registerType(definition)
    },
  }))
}
