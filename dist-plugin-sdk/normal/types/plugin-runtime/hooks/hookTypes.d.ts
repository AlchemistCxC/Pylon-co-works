export declare const HOOK_NAMES: readonly ["session.creating", "session.created", "session.loading", "session.loaded", "session.closing", "session.closed", "session.deleting", "session.deleted", "message.user.beforeSend", "message.user.sent", "message.user.sendFailed", "message.agent.committed", "turn.started", "turn.completed", "turn.failed", "turn.cancelled", "tool.beforeCall", "tool.started", "tool.afterCall", "tool.failed", "context.beforeBuild", "context.afterBuild"];
export type HookName = typeof HOOK_NAMES[number];
export type HookMode = 'notification' | 'pipeline';
export type HookExecution = 'blocking' | 'background';
export type HookFailurePolicy = 'continue' | 'abort' | 'disable-hook' | 'disable-plugin';
export interface HookInvocationContext<TEvent = unknown> {
    readonly invocationId: string;
    readonly hookName: HookName;
    readonly event: TEvent;
    readonly signal: AbortSignal;
}
export type HookActionResult<TEvent = unknown> = {
    action: 'continue';
    event?: TEvent;
} | {
    action: 'cancel';
    reason: string;
} | {
    action: 'respond';
    output: unknown;
} | void;
export interface HookDefinition<TEvent = unknown> {
    id: string;
    mode: HookMode;
    priority?: number;
    execution?: HookExecution;
    timeoutMs?: number;
    failurePolicy?: HookFailurePolicy;
    handler(context: HookInvocationContext<TEvent>): HookActionResult<TEvent> | Promise<HookActionResult<TEvent>>;
}
export interface HookTraceEntry {
    invocationId: string;
    hookName: HookName;
    pluginId: string;
    runtimeInstanceId: string;
    handlerId: string;
    startedAt: number;
    durationMs: number;
    outcome: 'continued' | 'transformed' | 'cancelled' | 'responded' | 'failed' | 'timed-out' | 'skipped' | 'plugin-disable-failed';
    error?: string;
}
export interface HookInvocationResult<TEvent = unknown> {
    action: 'continue' | 'cancel' | 'respond';
    event: TEvent;
    reason?: string;
    output?: unknown;
    executed: number;
    skipped: number;
}
export interface HookCircuitDescriptor {
    pluginId: string;
    failures: number;
    openedAt: number | null;
}
