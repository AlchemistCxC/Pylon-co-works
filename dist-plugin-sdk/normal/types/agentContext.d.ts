/**
 * AgentContext — 结构化 Agent 上下文（I01-W2）。
 *
 * 前端统一用 `AgentContext = { agentId, source }` 标识"哪个 Agent 的哪个 source"，
 * 只在 Record/持久化边界转 `AgentContextKey`（JSON.stringify([agentId, source])，
 * 禁止 `${agentId}:${source}` 字符串拼接——source 本身可能含冒号）。
 *
 * 目标：两个 Agent 使用同名 source 时，运行态/配置/统计完全隔离（I01 目标行为 3）。
 */
export interface AgentContext {
    agentId: string;
    source: string;
}
export type AgentContextKey = string & {
    readonly __brand: 'AgentContextKey';
};
export declare function toAgentContextKey(context: AgentContext): AgentContextKey;
/** 从 Session（含 agentId/source）构造上下文。 */
export declare function sessionContext(session: Pick<AgentContext, 'agentId' | 'source'>): AgentContext;
