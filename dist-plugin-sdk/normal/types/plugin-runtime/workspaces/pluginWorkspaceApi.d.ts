import type { WorkspaceTypeDefinition } from '../../workspace-sheets/workspaceTypes.js';
import { listOpenWorkspaces, openWorkspace, type WorkspaceOpenInput } from '../../workspace-sheets/workspaceController.js';
import { type WorkspaceRegistryStore, type WorkspaceRegistryTransaction } from '../../workspace-sheets/workspaceRegistry.js';
import type { PluginIdentity } from '../pluginIdentity.js';
import type { PluginScope } from '../pluginScope.js';
export interface PluginWorkspaceApi {
    registerType(definition: WorkspaceTypeDefinition): ReturnType<WorkspaceRegistryStore['register']>;
    open(input: WorkspaceOpenInput): ReturnType<typeof openWorkspace>;
    focus(id: string): boolean;
    close(id: string): Promise<boolean>;
    list(): ReturnType<typeof listOpenWorkspaces>;
    listTypes(): readonly WorkspaceTypeDefinition[];
    describe(type: string): WorkspaceTypeDefinition | undefined;
}
/** v2 workspace API；所有注册句柄自动绑定当前插件实例的 PluginScope。 */
export declare function createPluginWorkspaceApi(registry: WorkspaceRegistryStore, identity: PluginIdentity, scope: PluginScope, transaction?: WorkspaceRegistryTransaction): PluginWorkspaceApi;
