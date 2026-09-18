import type { BuiltinPluginDefinition } from '../../plugin-runtime/pluginRuntime.ts'
import { BUILTIN_WORKSPACE_TYPES } from '../core/sheet/builtinWorkspacePlugins.ts'
import { BUILTIN_SEARCH_PROVIDERS } from '../core/search/builtinSearchProviders.ts'
import { BUILTIN_EXPORT_SOURCES } from '../core/export/builtinExportSources.ts'
import { BUILTIN_CANONICAL_MESSAGE_PROJECTOR } from '../core/projector/builtinProjector.ts'
import { BUILTIN_PYLON_WORKSPACE_ID } from './productPluginIds.ts'
import { mountFirstPartyStyleAssets } from './firstPartyStyleRuntime.ts'
import { loadBuiltinPylonWorkspaceStyles } from './packages/builtin.pylon-workspace/styleAssets.ts'
import { lazy } from 'react'
import { BUILTIN_FILE_WORKBENCH_CONTRIBUTIONS } from '../core/file/builtinFileWorkbench.ts'
import { createBuiltinFileCommandDefinitions } from '../core/file/builtinFileCommands.ts'
import { createBuiltinWorkspaceCommandDefinitions } from '../core/sheet/builtinWorkspaceCommands.ts'
import { createBuiltinBrowserCommandDefinitions } from '../core/browser/builtinBrowserCommands.ts'
import { registerBuiltinBrowserAgentSessionAccess } from '../core/browser/builtinBrowserAgentSessionAccess.ts'

const SessionsPanel = lazy(() => import('../../components/sidebar/SessionsPanel.tsx'))
const ScheduledBlock = lazy(() => import('../../components/sidebar/blocks/mockBlocks.tsx').then(m => ({ default: m.ScheduledBlock })))
const AutomationBlock = lazy(() => import('../../components/sidebar/blocks/mockBlocks.tsx').then(m => ({ default: m.AutomationBlock })))
const TasksBlock = lazy(() => import('../../components/sidebar/blocks/mockBlocks.tsx').then(m => ({ default: m.TasksBlock })))
const ExtensionsBlock = lazy(() => import('../../components/sidebar/blocks/mockBlocks.tsx').then(m => ({ default: m.ExtensionsBlock })))
const AgentContextPanel = lazy(() => import('../../components/right-panel/AgentContextPanel.tsx'))
const FileContextPanel = lazy(() => import('../../components/right-panel/FileContextPanel.tsx'))

/**
 * 左栏「模块区」的占位区块。**这是 mock**：只验证区块栈模型（两区高度分配、折叠、
 * 模块区自身滚动、**展开成主区整页**），不接任何域。前两项声明了 `page`，
 * 点标题即把内容展开成主区整页；后两项只能折叠，用来对照两种模块形态。
 * 真实能力落地时逐个替换 `component` 即可，宿主外壳、折叠状态、`page` 声明与
 * `headerActions` 协议都不需要再动。
 */
const MOCK_MODULE_BLOCKS = [
  { id: 'builtin.sidebar.module.scheduled', label: '定时', order: 100, component: ScheduledBlock, page: { title: '定时' } },
  { id: 'builtin.sidebar.module.automation', label: '自动化', order: 200, component: AutomationBlock, page: { title: '自动化' } },
  { id: 'builtin.sidebar.module.tasks', label: '任务', order: 300, component: TasksBlock },
  { id: 'builtin.sidebar.module.extensions', label: '扩展', order: 400, component: ExtensionsBlock },
] as const

export function createBuiltinPylonWorkspacePlugin(): BuiltinPluginDefinition {
  return {
    id: BUILTIN_PYLON_WORKSPACE_ID,
    kind: 'workspace',
    firstParty: true,
    hotSwapMode: 'parallel',
    activate: context => {
      mountFirstPartyStyleAssets(BUILTIN_PYLON_WORKSPACE_ID, context.identity.key, context.scope, loadBuiltinPylonWorkspaceStyles())
      for (const definition of BUILTIN_WORKSPACE_TYPES) context.workspace.registerType(definition)
      context.sidebar.registerAgentSidebarContribution({
        id: 'builtin.sidebar.agent.sessions',
        region: 'sessions',
        label: '会话',
        order: 100,
        // 会话区是左栏主体，折了就空了，因此不可折叠。
        collapsible: false,
        headerActions: [{ id: 'new-workspace', label: '工作区', title: '新建工作区', icon: 'plus' }],
        renderKind: 'first-party-react',
        component: SessionsPanel,
      })
      for (const block of MOCK_MODULE_BLOCKS) {
        context.sidebar.registerAgentSidebarContribution({
          id: block.id,
          region: 'modules',
          label: block.label,
          order: block.order,
          renderKind: 'first-party-react',
          component: block.component,
          ...('page' in block ? { page: block.page } : {}),
        })
      }
      for (const contribution of BUILTIN_FILE_WORKBENCH_CONTRIBUTIONS) context.fileWorkbench.register(contribution)
      for (const command of [...createBuiltinFileCommandDefinitions(), ...createBuiltinWorkspaceCommandDefinitions(), ...createBuiltinBrowserCommandDefinitions()]) {
        context.commands.register(command, { contributionId: `${BUILTIN_PYLON_WORKSPACE_ID}.${command.id}`, layer: 'feature', priority: command.priority })
      }
      // issue #82：浏览器 Agent 会话贡献——session/new 前按档位注入浏览器 MCP 桥。
      registerBuiltinBrowserAgentSessionAccess(context.sessionCreation)
      context.contextPanel.register({
        id: 'builtin.context-panel.agent',
        workspaceKind: 'agent',
        label: '上下文',
        order: 100,
        renderKind: 'first-party-react',
        component: AgentContextPanel,
      })
      context.contextPanel.register({
        id: 'builtin.context-panel.file',
        workspaceKind: 'file',
        label: '关联',
        order: 100,
        renderKind: 'first-party-react',
        component: FileContextPanel,
      })
      for (const provider of BUILTIN_SEARCH_PROVIDERS) {
        context.services.register('search', provider.providerId, provider)
      }
      for (const source of BUILTIN_EXPORT_SOURCES) {
        context.services.register('export', source.sourceId, source)
      }
      context.services.register(
        'event-projector',
        BUILTIN_CANONICAL_MESSAGE_PROJECTOR.projectorId,
        BUILTIN_CANONICAL_MESSAGE_PROJECTOR,
      )
    },
  }
}
