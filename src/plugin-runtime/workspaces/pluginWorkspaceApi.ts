import type { SheetId, SheetRecord } from '../../contracts/sheets.ts'
import type { WorkspaceTypeDefinition } from './workspaceTypes.ts'
import { workspaceController, type WorkspaceOpenInput } from './workspaceControllerPort.ts'
import {
  type WorkspaceRegistryStore,
  type WorkspaceRegistryTransaction,
} from './workspaceRegistry.ts'
import type { PluginIdentity } from '../pluginIdentity.ts'
import type { PluginScope } from '../pluginScope.ts'

export type { WorkspaceOpenInput } from './workspaceControllerPort.ts'

export interface PluginWorkspaceApi {
  registerType(definition: WorkspaceTypeDefinition): ReturnType<WorkspaceRegistryStore['register']>
  open(input: WorkspaceOpenInput): SheetId | null
  focus(id: SheetId): boolean
  close(id: SheetId): Promise<boolean>
  list(): readonly SheetRecord[]
  listTypes(): readonly WorkspaceTypeDefinition[]
  describe(type: string): WorkspaceTypeDefinition | undefined
}

/**
 * v2 workspace API；所有注册句柄自动绑定当前插件实例的 PluginScope。
 * open/focus/close/list 经 workspaceControllerPort 委托（B-2b：视图编排实现由
 * app/bootstrap/workspaceControllerWiring 装配，plugin-runtime 不再 import 视图）。
 */
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
    open: input => workspaceController().open(input),
    focus: id => workspaceController().focus(id),
    close: id => workspaceController().close(id),
    list: () => workspaceController().list(),
    listTypes: () => registry.list(),
    describe: type => registry.resolve(type),
  }
}
