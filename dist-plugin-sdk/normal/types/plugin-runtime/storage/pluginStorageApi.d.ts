/**
 * pluginStorageApi — PluginStorageApi 的宿主实现。
 *
 * 持久化：localStorage 单键 `pylon-plugin-storage`（模块级缓存，同步读写）；
 * localStorage 不可用（测试/禁储环境）回退进程内存。
 * 配额：每插件序列化体积软上限（PER_PLUGIN_BUDGET_BYTES），超限抛错。
 */
import type { PluginIdentity } from '../pluginIdentity.js';
import type { PluginStorageApi } from './pluginStorageTypes.js';
export { PLUGIN_STORAGE_BUDGET_BYTES, PluginStorageError } from './pluginStorageContract.js';
export declare function createPluginStorageApi(identity: PluginIdentity): PluginStorageApi;
