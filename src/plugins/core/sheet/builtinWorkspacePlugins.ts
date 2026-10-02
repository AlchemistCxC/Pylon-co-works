import { lazy, type Component } from 'solid-js'
import type { BuiltinPluginDefinition } from '../../../plugin-runtime/pluginRuntime.ts'
import type { WorkspaceTypeDefinition, WorkspaceViewProps } from '../../../plugin-runtime/workspaces/workspaceTypes.ts'
import {
  deserializeAgentWorkspaceState,
  serializeAgentWorkspaceState,
} from '../../../workspace-sheets/agentWorkspaceState.ts'
import {
  deserializeSettingsSheetState,
  serializeSettingsSheetState,
} from '../../../workspace-sheets/settingsSheetState.ts'

// #515 贡献面翻转：workspace 渲染面是 **Solid 实体**（此前注册的是 React 薄桥）。
// 本文件留在 React 类型图（.ts），不得静态 import .solid 文件——按 P52 D4 经 glob 缝
// （运行期模块解析，零类型图边）加载，solid `lazy` 保留代码分割。Suspense 由宿主侧
// （SheetHost / Sidebar 实体）承担：solid `lazy` 只进 solid Suspense。
interface WorkspaceComponentSolidModule { default: Component<WorkspaceViewProps> }

const solidLoaders = import.meta.glob<WorkspaceComponentSolidModule>([
  '../../../sheets/AgentSheetView.solid.tsx',
  '../../../sheets/RuntimeSheetView.solid.tsx',
  '../../../sheets/file/FileSheetView.solid.tsx',
  '../../../sheets/OverviewSheetView.solid.tsx',
  '../../../sheets/search/SearchSheetView.solid.tsx',
  '../../../sheets/history/HistorySheetView.solid.tsx',
  '../../../sheets/browser/BrowserSheetView.solid.tsx',
  '../../../sheets/docs/DocsSheetView.solid.tsx',
  '../../../sheets/SettingsSheetSidebar.solid.tsx',
  '../../../components/Sidebar.solid.tsx',
  '../../../components/Settings.solid.tsx',
])

/** sheet 缺省加载态（原 React 版 loadingFallback 的 DOM 逐字节保留；宿主 Suspense 消费）。 */
export const WORKSPACE_LOADING_FALLBACK_MARKUP = {
  host: 'sheet-empty-host',
  kicker: 'sheet-empty-kicker',
  kickerText: 'LOADING',
  hint: '加载模块…',
} as const

function sheetComponent(path: string): Component<WorkspaceViewProps> {
  const load = solidLoaders[path]
  if (!load) throw new Error(`Workspace Solid 实体未进入 Vite module graph：${path}`)
  // #154 阶段 4：state 透传——settings sheet 的主区视图消费 WorkspaceViewProps 全量；
  // 只声明 { sheet, ctx } 的既有视图不受影响（多余 prop 被忽略）。
  // 注册表边界的 state 是 unknown，泛型在此收口（与 deserialize 的归一职责一致）。
  return lazy(() => load())
}

const singleton = (key: string) => () => key
const agentSingleton: WorkspaceTypeDefinition['getSingletonKey'] = input => input.agentId ? `agent:${input.agentId}` : undefined
const fileSingleton: WorkspaceTypeDefinition['getSingletonKey'] = input => input.singletonKey
function defineWorkspace(
  definition: Omit<WorkspaceTypeDefinition<unknown>, 'createInitialState' | 'serialize' | 'deserialize'>
    & Partial<Pick<WorkspaceTypeDefinition<unknown>, 'createInitialState' | 'serialize' | 'deserialize'>>,
): WorkspaceTypeDefinition<unknown> {
  return Object.freeze({
    ...definition,
    createInitialState: definition.createInitialState ?? emptyState,
    serialize: definition.serialize ?? serializeEmptyState,
    deserialize: definition.deserialize ?? deserializeEmptyState,
  })
}

const emptyState = () => undefined
const serializeEmptyState = () => undefined
const deserializeEmptyState = () => undefined

export const BUILTIN_WORKSPACE_TYPES: readonly WorkspaceTypeDefinition<unknown>[] = [
  { kind: 'agent', label: 'Agent', singleton: true, getSingletonKey: agentSingleton, sidebarMode: 'workspace', component: sheetComponent('../../../sheets/AgentSheetView.solid.tsx'), sidebar: sheetComponent('../../../components/Sidebar.solid.tsx'), createInitialState: deserializeAgentWorkspaceState, serialize: serializeAgentWorkspaceState, deserialize: deserializeAgentWorkspaceState },
  defineWorkspace({ kind: 'runtime', label: 'Runtime', singleton: true, getSingletonKey: singleton('runtime'), sidebarMode: 'sheet', component: sheetComponent('../../../sheets/RuntimeSheetView.solid.tsx'), launch: { kind: 'runtime', title: 'Runtime', description: '运行日志与启动诊断', launchable: true, icon: 'activity', category: 'observe', categoryLabel: '观察与诊断', categoryOrder: 20, order: 30, keywords: ['log', 'debug', 'diagnostic', '运行日志', '诊断', '日志'] } }),
  defineWorkspace({ kind: 'file', label: 'File', singleton: false, getSingletonKey: fileSingleton, sidebarMode: 'sheet', component: sheetComponent('../../../sheets/file/FileSheetView.solid.tsx'), launch: { kind: 'file', title: 'File', description: '工作区文件、SCM 与搜索', launchable: true, icon: 'folder-tree', category: 'work', categoryLabel: '工作台', categoryOrder: 10, order: 10, keywords: ['git', 'scm', 'code', '文件', '工作区', '搜索文件'] } }),
  defineWorkspace({ kind: 'overview', label: 'Overview', singleton: true, getSingletonKey: singleton('overview'), sidebarMode: 'sheet', component: sheetComponent('../../../sheets/OverviewSheetView.solid.tsx'), launch: { kind: 'overview', title: 'Overview', description: '工作状态与最近会话概览', launchable: true, icon: 'layout-dashboard', category: 'observe', categoryLabel: '观察与诊断', categoryOrder: 20, order: 10, keywords: ['dashboard', 'summary', '概览', '总览', '工作台'] } }),
  defineWorkspace({ kind: 'search', label: 'Search', singleton: true, getSingletonKey: singleton('search'), sidebarMode: 'sheet', component: sheetComponent('../../../sheets/search/SearchSheetView.solid.tsx'), launch: { kind: 'search', title: 'Search', description: '跨会话快照搜索', launchable: true, icon: 'search', category: 'work', categoryLabel: '工作台', categoryOrder: 10, order: 30, keywords: ['find', 'snapshot', '搜索', '查找', '快照'] } }),
  defineWorkspace({ kind: 'history', label: 'History', singleton: true, getSingletonKey: singleton('history'), sidebarMode: 'sheet', component: sheetComponent('../../../sheets/history/HistorySheetView.solid.tsx'), launch: { kind: 'history', title: 'History', description: '存档会话列表与导出', launchable: true, icon: 'history', category: 'observe', categoryLabel: '观察与诊断', categoryOrder: 20, order: 20, keywords: ['archive', 'export', '历史', '存档', '导出'] } }),
  defineWorkspace({ kind: 'browser', label: 'Browser', singleton: true, getSingletonKey: singleton('browser'), sidebarMode: 'sheet', component: sheetComponent('../../../sheets/browser/BrowserSheetView.solid.tsx'), launch: { kind: 'browser', title: 'Browser', description: '多标签网页工作区', launchable: true, icon: 'globe', category: 'work', categoryLabel: '工作台', categoryOrder: 10, order: 20, keywords: ['web', 'url', '浏览器', '网页', '标签页'] } }),
  // #371：离线文档站——pylon-docs:// scheme + 专用 Sheet，不占 Browser 的 http/https 语义。
  defineWorkspace({ kind: 'docs', label: 'Docs', singleton: true, getSingletonKey: singleton('docs'), sidebarMode: 'sheet', component: sheetComponent('../../../sheets/docs/DocsSheetView.solid.tsx'), launch: { kind: 'docs', title: '文档', description: '离线文档站（应用内查看）', launchable: true, icon: 'book-open', category: 'reference', categoryLabel: '参考与帮助', categoryOrder: 40, order: 10, keywords: ['docs', 'documentation', 'manual', '帮助', '文档', '说明书'] } }),
  defineWorkspace({
    kind: 'settings', label: '设置', singleton: true, getSingletonKey: singleton('settings'), sidebarMode: 'sheet',
    // #154 阶段 4：设置由固定覆盖层迁入 sheet 体系——一二级导航走注册表 sidebar，
    // 导航态 { domain, section, … } 经 settingsSheetState 编解码持久化（深链契约零迁移）。
    component: sheetComponent('../../../components/Settings.solid.tsx'), sidebar: sheetComponent('../../../sheets/SettingsSheetSidebar.solid.tsx'),
    createInitialState: deserializeSettingsSheetState, serialize: serializeSettingsSheetState, deserialize: deserializeSettingsSheetState,
  }),
] as const

export function createBuiltinWorkspacePluginDefinitions(): readonly BuiltinPluginDefinition[] {
  return BUILTIN_WORKSPACE_TYPES.map(definition => ({
    id: `core.sheet.${definition.kind}`,
    activate: ({ workspace }) => {
      workspace.registerType(definition)
    },
  }))
}
