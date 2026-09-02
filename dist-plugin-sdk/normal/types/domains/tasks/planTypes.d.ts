/**
 * planTypes — plan 任务域 wire 收窄（P1-01，D1-D4）。
 *
 * D1：plan 事件 = 全量快照替换（reducer 无 diff/合并）。
 * D2：不引入 id / blockedBy——协议没有，渲染不做假设；排序 = 数组顺序 = 模型写入顺序。
 * D3：完成节奏不进状态（派生不进状态）；完成动画由组件层监听 entries 前后对比触发。
 * D4：tasks 进会话运行时（sessionRuntimeStore），不进全局统计。
 */
export declare const PLAN_STATUSES: readonly ["pending", "in_progress", "completed", "failed", "cancelled"];
export type PlanStatus = (typeof PLAN_STATUSES)[number];
export interface PlanEntry {
    content: string;
    priority?: number;
    /** 未知状态容错：normalize 保留 'unknown'，渲染中性处理，不崩 */
    status: PlanStatus | 'unknown';
}
export interface PlanState {
    entries: PlanEntry[];
}
export declare const EMPTY_PLAN_STATE: PlanState;
/** wire entries 容错收窄：非数组 → []；缺 content 丢弃；未知 status → 'unknown'；priority 仅数字保留 */
export declare function normalizePlanEntries(raw: unknown): PlanEntry[];
