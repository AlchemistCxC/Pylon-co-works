import type { WorkspaceTypeDefinition } from '../../workspace-sheets/workspaceTypes.ts'
import {
  closeWorkspace,
  focusWorkspace,
  listOpenWorkspaces,
  openWorkspace,
  type WorkspaceOpenInput,
} from '../../workspace-sheets/workspaceController.ts'
import {
  type WorkspaceRegistryStore,
  type WorkspaceRegistryTransaction,
} from '../../workspace-sheets/workspaceRegistry.ts'
import type { PluginIdentity } from '../pluginIdentity.ts'
import type { PluginScope } from '../pluginScope.ts'

export interface PluginWorkspaceApi {
  registerType(definition: WorkspaceTypeDefinition): ReturnType<WorkspaceRegistryStore['register']>
  open(input: WorkspaceOpenInput): ReturnType<typeof openWorkspace>
  focus(id: string): boolean
  close(id: string): Promise<boolean>
  list(): ReturnType<typeof listOpenWorkspaces>
  listTypes(): readonly WorkspaceTypeDefinition[]
  describe(type: string): WorkspaceTypeDefinition | undefined
}

/** v2 workspace API；所有注册句柄自动绑定当前插件实例的 PluginScope。 */
export function createPluginWorkspaceApi(
  registry: WorkspaceRegistryStore,
  identity: PluginIdentity,
  scope: PluginScope,
  transaction?: WorkspaceRegistryTransaction,
): PluginWorkspaceApi {
  return {
    registerType(definition) {
      if (scope.isDisposed) throw new Error(`PluginScope 已释放：${scope.ownerKey}`)
      const registration = transaction
        ? transaction.register(definition)
        : registry.register(identity, definition)
      try {
        return scope.add(registration)
      } catch (error) {
        void registration.dispose()
        throw error
      }
    },
    open: input => openWorkspace(input),
    focus: id => focusWorkspace(id),
    close: id => closeWorkspace(id),
    list: () => listOpenWorkspaces(),
    listTypes: () => registry.list(),
    describe: type => registry.resolve(type),
  }
}
