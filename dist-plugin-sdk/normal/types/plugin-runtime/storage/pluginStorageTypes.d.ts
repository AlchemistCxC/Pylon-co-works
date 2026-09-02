/**
 * pluginStorageTypes — 插件通用 KV 存储（API 1.1 新增）。
 *
 * 设计：
 * - 按插件 id 命名空间隔离，互不可见；
 * - 值必须可 JSON 序列化（与 settings 同纪律）；
 * - 每插件软配额（host 常量），超限抛 PluginStorageError，不静默丢弃；
 * - 与 settings 的分工：settings 面向“设置页可编辑的用户偏好”，storage
 *   面向“插件私有的运行状态”，后者不进设置页。
 */
export interface PluginStorageApi {
    getValue<T = unknown>(key: string): T | undefined;
    setValue(key: string, value: unknown): void;
    removeValue(key: string): void;
    keys(): string[];
    /** 清空当前插件命名空间（不影响其他插件） */
    clear(): void;
    subscribe(listener: () => void): () => void;
}
