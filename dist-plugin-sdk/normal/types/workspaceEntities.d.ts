/**
 * CWD-03：Workspace 实体（方案 C）前端域类型 + localStorage 镜像持久化。
 *
 * 权威源 = 后端注册表（workspace_create/list/update/delete 命令）；localStorage 仅作
 * 镜像缓存（与 sessionPersistence 同模式：Tauri 模式以后端为准，浏览器模式读镜像）。
 * 纯域模块，零 store 依赖，node 可测。
 */
export interface Workspace {
    id: string;
    /** 创建者 agentId（owner 溯源；跨 Agent 共享见 CWD-01 决策 4，可见性 = 所有 Agent） */
    agentId: string;
    name: string;
    /** 绝对路径工作目录（唯一 root 来源；创建/更新时前端校验绝对路径，后端二次校验） */
    rootPath: string;
    createdAt: number;
    lastActiveAt: number;
    /** cwd 级 skills（会话在 cwd 下创建时继承快照）。 */
    skills: string[];
    /** cwd 级 MCP 选择：agent 暴露的 MCP server 中，本 cwd 选择启用哪些（按名称）。 */
    mcpServerIds: string[];
    /** cwd 级 hook 插件 id（工作区级插件 hook；会话在 cwd 下创建时继承快照）。 */
    hookPluginIds: string[];
}
export declare const WORKSPACE_STORAGE_KEY = "pylon-workspaces";
export declare const WORKSPACE_ENVELOPE_VERSION = 1;
export declare function serializeWorkspaces(workspaces: Workspace[]): string;
export declare function parseWorkspaces(raw: string | null): Workspace[];
/** 后端/存储原始值 → 规范化 Workspace（缺字段防御；id 缺失 → null）。 */
export declare function normalizeWorkspaceShape(value: unknown): Workspace | null;
/** Windows 平台探测（CR-602：'/foo' 在 Rust Windows std::path 语义下仅 has_root 无盘符
 * 前缀 → is_relative=true → 非绝对；前端校验须与后端 validate_absolute_path 同口径，
 * 避免前端放行 → 后端拒绝的交互困惑）。Tauri WebView/浏览器均可用。 */
export declare function isWindowsPlatform(): boolean;
/** 绝对路径校验（CWD-01 契约：rootPath 必须为绝对路径；Windows/Unix 前缀均可）。
 * 与后端 validate_absolute_path（Rust Path::is_absolute）口径一致（CR-602）：
 * Windows 上裸 '/' 前缀有 root 无盘符 prefix → 非绝对 → 前端同判拒绝；
 * Unix 上 '/' 前缀即绝对。isWindows 参数供测试显式注入平台分支。 */
export declare function isAbsolutePath(path: string, isWindows?: boolean): boolean;
/** CWD-03：浏览器/离线模式的本地 id 生成（'w' + millis36，后缀去重）。 */
export declare function newLocalWorkspaceId(existing: Workspace[], now?: number): string;
