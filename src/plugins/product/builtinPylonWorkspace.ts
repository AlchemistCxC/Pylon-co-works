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

const ChatSessionsPanel = lazy(() => import('../../components/sidebar/ChatSessionsPanel.tsx'))
const WorkspacesPanel = lazy(() => import('../../components/sidebar/WorkspacesPanel.tsx'))
const AgentContextPanel = lazy(() => import('../../components/right-panel/AgentContextPanel.tsx'))
const FileContextPanel = lazy(() => import('../../components/right-panel/FileContextPanel.tsx'))

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
        id: 'builtin.sidebar.agent.workspaces',
        mode: 'work',
        label: '工作区',
        order: 100,
        renderKind: 'first-party-react',
        component: WorkspacesPanel,
      })
      for (const contribution of BUILTIN_FILE_WORKBENCH_CONTRIBUTIONS) context.fileWorkbench.register(contribution)
      for (const command of [...createBuiltinFileCommandDefinitions(), ...createBuiltinWorkspaceCommandDefinitions(), ...createBuiltinBrowserCommandDefinitions()]) {
        context.commands.register(command, { contributionId: `${BUILTIN_PYLON_WORKSPACE_ID}.${command.id}`, layer: 'feature', priority: command.priority })
      }
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
      context.sidebar.registerAgentSidebarContribution({
        id: 'builtin.sidebar.agent.chat-sessions',
        mode: 'chat',
        label: '聊天会话',
        order: 200,
        renderKind: 'first-party-react',
        component: ChatSessionsPanel,
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
