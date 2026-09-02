/**
 * Pylon 插件 SDK 测试基建（`@pylon/plugin-sdk/testing`）。
 *
 * 仅供插件的测试文件 import —— 不进入插件生产 bundle：
 * - 引用了宿主 PluginScope 真实类，保留真实的资源回收纪律；
 * - 记录式 mock：命令可执行、Hook 可分发、设置/存储/会话为内存实现、
 *   其余 13 个 API 面以 Proxy 记录调用（调用即记录，返回 undefined）。
 */
import { PluginScope } from '../plugin-runtime/pluginScope.js';
import type { BuiltinPluginActivationContext } from '../plugin-runtime/pluginActivationContext.js';
import type { CommandDefinition } from '../plugin-runtime/commands/commandRegistry.js';
import type { HookDefinition, HookInvocationResult, HookName } from '../plugin-runtime/hooks/hookTypes.js';
import type { PluginSettingValue } from '../plugin-runtime/settings/pluginSettingsTypes.js';
import type { PluginUiSurface } from '../plugin-runtime/ui/pluginUiTypes.js';
export interface MockRecordedCall {
    readonly member: string;
    readonly method: string;
    readonly args: readonly unknown[];
}
export interface MockContextOptions {
    pluginId?: string;
    runtimeInstanceId?: string;
    /** 预置 settings 值（键值即 PluginSettingsApi 语义） */
    settingsValues?: Record<string, PluginSettingValue>;
    /** 预置 storage 值（按 PluginStorageApi 语义隔离） */
    storageValues?: Record<string, unknown>;
}
export interface MockSurfaceDriver {
    container: HTMLElement;
    /** 模拟宿主向 surface 派发输入（PluginSettingsPageHost 同款事件名） */
    hostInput(values: Record<string, unknown>): void;
    events: Array<{
        event: string;
        detail: unknown;
    }>;
    unmount(): Promise<void>;
}
export interface MockPluginActivationContext extends BuiltinPluginActivationContext {
    readonly scope: PluginScope;
    readonly __commands: {
        registered: CommandDefinition[];
        execute(id: string, args?: unknown): Promise<unknown>;
    };
    readonly __hooks: {
        registered: Array<{
            hookName: HookName;
            definition: HookDefinition;
        }>;
        dispatch(name: HookName, event: unknown): Promise<HookInvocationResult<unknown>>;
    };
    readonly __ui: {
        surfaces: PluginUiSurface[];
        /** 按 surface id 挂载并返回驱动器（容器 + 桥） */
        mount(surfaceId: string): MockSurfaceDriver;
    };
    readonly __settings: {
        values: Record<string, unknown>;
        changeCount(): number;
    };
    readonly __storage: {
        values: Record<string, unknown>;
        changeCount(): number;
    };
    readonly __recorded: readonly MockRecordedCall[];
    readonly __scopeDispose: () => Promise<void>;
}
export declare function createMockContext(options?: MockContextOptions): MockPluginActivationContext;
export type { PluginUiEventBridge } from '../plugin-runtime/ui/pluginUiTypes.js';
export { PluginStorageError } from '../plugin-runtime/storage/pluginStorageContract.js';
