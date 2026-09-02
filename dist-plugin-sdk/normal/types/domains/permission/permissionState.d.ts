/**
 * permissionState — 权限请求纯状态机（P0-01，P1-1 按 agent 隔离）。
 *
 * R2-WI05（Phase E）：不再使用全局单 active 槽——状态按 `request.agentId` 分片
 * （byAgent），同 provider 多 agentId / 同 agent 多 session 的请求互不串槽；
 * 后台 agent 的请求停放在其切片内，切回该 agent 继续展示。每个 agent 切片内部
 * 保持既有语义：单 active + FIFO queue、每个 request 只应答一次、迟到 resolve
 * 无操作、options 保持 wire 顺序。
 *
 * 核心不变量：**每个 request 只应答一次**——同 requestId 第二次 choose 无操作；
 * 迟到 resolve（请求已 timeout/settled 被弹出）无操作；settled 的请求即被丢弃。
 * 超时/拒绝选项选择等 wire 语义由 controller（P0-02）翻译后 dispatch，本域不解释 wire。
 */
import type { PermissionRequest } from './permissionTypes.js';
export type PermissionStatus = 'pending' | 'answering' | 'settled' | 'timed-out';
export interface PermissionRequestState {
    request: PermissionRequest;
    status: PermissionStatus;
    receivedAt: number;
    chosenOptionId?: string;
    lastError?: string;
}
/** 单个 agent 的权限切片（单 active + FIFO queue，语义与旧全局状态一致）。 */
export interface PermissionAgentSlice {
    active: PermissionRequestState | null;
    queued: PermissionRequestState[];
}
/** 按 agentId 分片的权限状态——同 provider 多 agentId / 多 session 不串槽。 */
export interface PermissionState {
    byAgent: Record<string, PermissionAgentSlice>;
}
export declare const EMPTY_PERMISSION_STATE: PermissionState;
export declare function emptyAgentSlice(): PermissionAgentSlice;
/** 当前 agent 的 active 请求（无则 null）。 */
export declare function activeForAgent(state: PermissionState, agentId: string): PermissionRequestState | null;
/** 当前 agent 的完整切片（无则空切片，不产生新引用写入）。 */
export declare function sliceForAgent(state: PermissionState, agentId: string): PermissionAgentSlice;
export type PermissionAction = {
    type: 'receive';
    request: PermissionRequest;
    now?: number;
} | {
    type: 'choose';
    agentId: string;
    requestId: string;
    optionId: string;
} | {
    type: 'resolve';
    agentId: string;
    requestId: string;
    ok: boolean;
    error?: string;
    clientGeneration?: number;
}
/** 本地 settle（无 deny 项时 controller 用，不 invoke） */
 | {
    type: 'reject';
    agentId: string;
    requestId: string;
} | {
    type: 'timeout';
    agentId: string;
    requestId: string;
}
/** 清理指定 agent 的全部权限状态（重连/切换场景用） */
 | {
    type: 'clear-agent';
    agentId: string;
} | {
    type: 'clear';
};
export declare function permissionReducer(state: PermissionState, action: PermissionAction): PermissionState;
