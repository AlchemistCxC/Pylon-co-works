import type { LegacySession } from '../../sessionPersistence';
import type { AgentEntry } from '../../identityStore';
import type { TransactionResult } from '../../application/transactions/transactionResult';
export interface UnresolvedOwnerResolutionDeps {
    /** 必须从当前 store 读取，禁止使用打开 UI 时捕获的旧数组。 */
    getUnresolved: () => readonly LegacySession[];
    getAgents: () => readonly AgentEntry[];
    /** 提交层负责 normalize、写回及 store 更新；失败时不得清理 unresolved。 */
    commit: (session: LegacySession, agentId: string) => Promise<void>;
}
/**
 * TS-WI02：单条 unresolved owner 指定事务。
 *
 * 读取最新现场 → 校验目标仍 unresolved → 校验 Agent 仍存在 → 提交。
 * 本函数不在成功前修改任何状态，也不把取消解释为默认 Agent。
 */
export declare function resolveUnresolvedSessionTransaction(sessionId: string, agentId: string | null | undefined, deps: UnresolvedOwnerResolutionDeps): Promise<TransactionResult<string>>;
