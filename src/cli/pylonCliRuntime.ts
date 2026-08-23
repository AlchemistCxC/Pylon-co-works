import { getPackageInstallationService, getPluginPackageClient, getPluginRuntime, getPluginProcessClient } from '../plugin-runtime/pluginCompositionRoot.ts'
import { getAgentSidebarRegistry, getCommandRegistry, getContextPanelRegistry, getFileWorkbenchRegistry, getHookRuntime, getPluginServiceRegistry, getPluginSettingsPageRegistry, getPluginUiRegistry, getPresentationProfileRegistry, getRendererRegistry } from '../plugin-runtime/runtimeServices.ts'
import { closeWorkspace, listOpenWorkspaces, openWorkspace } from '../workspace-sheets/workspaceController.ts'
import { getWorkspaceRegistrySnapshot } from '../workspace-sheets/workspaceRegistry.ts'
import { PylonCliService, createPylonCliTool } from './pylonCliService.ts'
import { createCliAgentControlPort, createCliApprovalControlPort, createCliInteractionControlPort, createCliSessionConfigControlPort, createCliSessionControlPort, createCliWorkspaceRegistryControlPort } from './pylonCliDomainPorts.ts'

let service: PylonCliService | undefined

export function getPylonCliService(): PylonCliService {
  if (service) return service
  const runtime = getPluginRuntime()
  const hooks = getHookRuntime()
  const processClient = getPluginProcessClient()
  service = new PylonCliService({
    plugins: {
      snapshot: () => runtime.snapshot(),
      enable: pluginId => runtime.enable(pluginId),
      disable: pluginId => runtime.disable(pluginId),
      reload: (pluginId, mode) => runtime.reload(pluginId, mode),
    },
    hooks: {
      list: () => hooks.registry.getSnapshot().entries.map(entry => ({
        hookName: entry.value.hookName,
        handlerId: entry.value.id,
        pluginId: entry.ownerPluginId,
        runtimeInstanceId: entry.ownerRuntimeInstanceId,
        priority: entry.value.priority ?? 1000,
        execution: entry.value.execution ?? 'blocking',
        failurePolicy: entry.value.failurePolicy ?? 'continue',
      })),
      trace: () => hooks.traceSnapshot().entries,
    },
    commands: {
      execute: (commandId, args, options) => getCommandRegistry().execute(commandId, args, options),
      list: filter => getCommandRegistry().list(filter),
      describe: commandId => getCommandRegistry().describe(commandId),
    },
    processes: {
      list: runtimeInstanceId => processClient.list(runtimeInstanceId),
      logs: (processId, stream, limit) => processClient.logs(processId, stream, limit),
      terminate: processId => processClient.terminate(processId),
    },
    workspaces: {
      list: listOpenWorkspaces,
      open: openWorkspace,
      close: closeWorkspace,
    },
    agents: createCliAgentControlPort(),
    sessions: createCliSessionControlPort(),
    approval: createCliApprovalControlPort(),
    interactions: createCliInteractionControlPort(),
    workspaceRegistry: createCliWorkspaceRegistryControlPort(),
    sessionConfig: createCliSessionConfigControlPort(),
    registries: {
      snapshot: () => {
        const renderers = getRendererRegistry().snapshot()
        const contribution = <T extends { contributionId: string, ownerPluginId: string, ownerRuntimeInstanceId: string, priority: number }>(entry: T) => ({
          id: entry.contributionId,
          pluginId: entry.ownerPluginId,
          runtimeInstanceId: entry.ownerRuntimeInstanceId,
          priority: entry.priority,
        })
        return {
          commands: getCommandRegistry().list(),
          workspaces: getWorkspaceRegistrySnapshot().entries.map(entry => ({
            kind: entry.descriptor.kind, label: entry.descriptor.label, sidebarMode: entry.descriptor.sidebarMode,
            pluginId: entry.ownerPluginId, runtimeInstanceId: entry.ownerRuntimeInstanceId,
          })),
          renderers: {
            message: renderers.messageRenderers.map(entry => ({ ...contribution(entry), rendererId: entry.value.renderer.rendererId })),
            content: renderers.contentRenderers.map(entry => ({ ...contribution(entry), kind: entry.value.kind, provider: entry.value.provider })),
            tool: renderers.toolRenderers.map(entry => ({ ...contribution(entry), kind: entry.value.kind })),
            highlighter: renderers.codeHighlighters.map(entry => contribution(entry)),
          },
          services: getPluginServiceRegistry().getSnapshot().entries.map(entry => ({ ...contribution(entry), kind: entry.value.kind, serviceId: entry.value.id })),
          uiSurfaces: getPluginUiRegistry().getSnapshot().entries.map(entry => contribution(entry)),
          sidebars: getAgentSidebarRegistry().getSnapshot().entries.map(entry => ({ ...contribution(entry), mode: entry.value.mode, label: entry.value.label })),
          fileWorkbench: getFileWorkbenchRegistry().getSnapshot().entries.map(entry => ({ ...contribution(entry), kind: entry.value.kind })),
          contextPanels: getContextPanelRegistry().getSnapshot().entries.map(entry => ({ ...contribution(entry), workspaceKind: entry.value.workspaceKind, label: entry.value.label })),
          presentationProfiles: getPresentationProfileRegistry().getSnapshot().entries.map(entry => ({ ...contribution(entry), label: entry.value.label, family: entry.value.family })),
          settingsPages: getPluginSettingsPageRegistry().getSnapshot().entries.map(entry => ({ ...contribution(entry), label: entry.value.label, renderKind: entry.value.renderKind })),
        }
      },
    },
    packages: {
      list: () => getPackageInstallationService().list(),
      inspect: sourcePath => getPackageInstallationService().inspect(sourcePath),
      installOrUpdate: sourcePath => getPackageInstallationService().installOrUpdate(sourcePath),
      setEnabled: (pluginId, enabled) => getPackageInstallationService().setEnabled(pluginId, enabled),
      reload: pluginId => getPackageInstallationService().reload(pluginId),
      versions: pluginId => getPluginPackageClient().versions(pluginId),
      rollback: async (pluginId, packageInstanceId) => {
        if (getPluginRuntime().snapshot().active.some(identity => identity.pluginId === pluginId)) {
          throw new Error(`回滚前必须先停用插件：${pluginId}`)
        }
        return getPluginPackageClient().rollback(pluginId, packageInstanceId)
      },
      uninstall: (pluginId, purgeData) => getPackageInstallationService().uninstall(pluginId, purgeData),
    },
  })
  return service
}

export function getPylonCliTool() {
  return createPylonCliTool(getPylonCliService())
}
