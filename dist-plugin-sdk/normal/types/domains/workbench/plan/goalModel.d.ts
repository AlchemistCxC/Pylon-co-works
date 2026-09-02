/**
 * C08：Todo / Plan / Goal 统一语义模型（纯 domain，无 IO/store/framework import）。
 *
 * - Todo/Plan 共用 PlanEntryV2：五状态 pending/in-progress/completed/cancelled/blocked；
 *   cancelled 不坍缩为 completed（总纲 4.4：Hermes ACP 会压状态，Pylon 端必须无损保留）。
 * - Goal 独立建模：objective/tokenBudget/blockedReason/tokensUsed 是 goal 一等字段，
 *   不是 todo 装饰。
 * - 未知 provider 状态映射 unknown + rawStatus；未知 goal 字段进 metadata，不静默丢弃
 *   （K14：unknown/raw 必须保留并可见）。
 */
export declare const PLAN_ENTRY_STATUSES: readonly ["pending", "in_progress", "completed", "cancelled", "blocked"];
export type PlanEntryStatus = (typeof PLAN_ENTRY_STATUSES)[number];
export declare const GOAL_STATUSES: readonly ["active", "complete", "blocked"];
export type GoalStatus = (typeof GOAL_STATUSES)[number] | 'unknown';
export interface PlanEntryV2 {
    /** stable item id：显式 id > itemId > content 兜底；patch/reorder 的定位键 */
    readonly id: string;
    readonly content: string;
    readonly status: PlanEntryStatus | 'unknown';
    readonly activeForm?: string;
    readonly priority?: string | number;
    readonly blockedReason?: string;
    /** provider 原始状态拼写（status 无法收窄时必填；可收窄时保留变体拼写） */
    readonly rawStatus?: string;
    /** 已知/未来 provider 字段；不得因结构化收窄而静默丢弃 */
    readonly metadata?: Readonly<Record<string, unknown>>;
}
export interface GoalAccounting {
    readonly tokensUsed?: number;
    readonly timeUsedSeconds?: number;
    /** provider-neutral accounting 扩展字段 */
    readonly metadata?: Readonly<Record<string, unknown>>;
}
export interface GoalSnapshot {
    readonly goalId?: string;
    readonly objective?: string;
    readonly status: GoalStatus;
    readonly tokenBudget?: number;
    readonly tokensUsed?: number;
    readonly blockedReason?: string;
    /** 预算/时间消耗的结构化 accounting；未知 accounting 字段进入 metadata */
    readonly accounting?: GoalAccounting;
    /** 未知字段聚合处；保证未来字段可见而非丢弃 */
    readonly metadata?: Readonly<Record<string, unknown>>;
}
export interface PlanState {
    readonly sessionId: string;
    readonly revision: number;
    readonly entries: readonly PlanEntryV2[];
}
export declare function createEmptyPlanState(sessionId: string): PlanState;
export interface GoalState {
    readonly current?: GoalSnapshot;
}
export interface PlanContentPayload {
    readonly entries: readonly PlanEntryV2[];
    readonly goal?: GoalSnapshot;
}
export declare function createEmptyGoalState(): GoalState;
export interface PlanEventInput {
    readonly type: 'plan.replaced' | 'plan.entry-updated';
    readonly entries?: readonly unknown[];
    readonly entry?: unknown;
}
export interface GoalEventInput {
    readonly type: 'goal.updated' | 'goal.cleared';
    readonly goal?: unknown;
    readonly goalId?: string;
}
/** provider 状态 → 五状态；未知拼写保留原文进 rawStatus。已归一化的 unknown 输入若自带 rawStatus 则原样保留 */
export declare function normalizePlanStatus(rawStatus: unknown): {
    status: PlanEntryStatus | 'unknown';
    rawStatus?: string;
};
/**
 * wire entries → PlanEntryV2[]。id 缺失时按 content 派生稳定身份；
 * 已归一化的 unknown 条目（status='unknown'+rawStatus）回读时保留 rawStatus。
 * 非 object 条目与缺 content 条目按契约丢弃（与 P1-01 normalizePlanEntries 行为一致）。
 */
export declare function normalizePlanEntries(raw: unknown): readonly PlanEntryV2[];
/**
 * plan 事件 reducer：
 * - replaced = 全量快照替换（保持 provider 顺序）；深等返回同一引用（终态幂等）。
 * - entry-updated = 按 stable id patch；目标不存在时以 patch 为种子追加（parent-late 容忍）。
 */
export declare function applyPlanEvent(state: PlanState, event: PlanEventInput): PlanState;
/** wire goal payload → GoalSnapshot；已知字段收窄，未知字段进 metadata */
export declare function normalizeGoalSnapshot(raw: unknown): GoalSnapshot | undefined;
/** goal 事件 reducer：updated = merge（partial 快照保活），cleared = 显式清除 */
export declare function applyGoalEvents(state: GoalState, event: GoalEventInput): GoalState;
export interface PlanProgress {
    readonly total: number;
    readonly completed: number;
    readonly active: number;
    readonly blocked: number;
    readonly cancelled: number;
}
export declare function selectPlanProgress(entries: readonly PlanEntryV2[]): PlanProgress;
/** React generic fallback 文本行：cancelled/blocked/unknown 全部可读 */
export declare function readablePlanLines(entries: readonly PlanEntryV2[]): readonly string[];
export declare function plainGoalSummary(goal: GoalSnapshot | undefined): string;
/** Renderer boundary guard: only the normalized Plan/Goal projection may enter content.plan. */
export declare function isValidPlanContentInput(input: unknown): input is PlanContentPayload;
