/** Backend-visible Agent instance projected into the product domain. */
export interface AgentEntry {
    id: string;
    name: string;
    /** Protocol/implementation category; distinct from the configured instance id. */
    provider?: string;
    transport?: string;
    exe?: string;
    /** User-authored process arguments, preserving argument boundaries. */
    args?: string[];
    /** Effective process arguments calculated by the backend. */
    effectiveArgs?: string[];
    default?: boolean;
    active?: boolean;
    available?: boolean;
    crashed?: boolean;
    cwd?: string;
    configActivationState?: 'stored' | 'pendingRestart' | 'activated';
    /** Agent Instance YAML 的工具 overlay；不改变 provider catalog baseline。 */
    toolOverlay?: unknown;
    tools?: unknown;
}
/** Embedded 示例中的 `<...>` 仅是安装占位符，不能被当作可启动命令。 */
export declare function isAgentInvocationConfigured(agent: Pick<AgentEntry, 'exe'> | undefined): boolean;
