import type { RuntimeErrorMatcher } from './errorCenter.js';
export type RecoveryKind = 'open-agent-settings' | 'select-agent-executable' | 'open-runtime-log';
export type RuntimeErrorSeverity = 'error' | 'warning' | 'info';
export type RuntimeErrorVisibility = 'global' | 'diagnostic';
export type RuntimeErrorScopeKind = 'app' | 'agent' | 'session' | 'sheet' | 'operation';
export interface RuntimeErrorScope {
    kind: RuntimeErrorScopeKind;
    id: string;
}
export interface RuntimeErrorRecovery {
    kind: RecoveryKind;
    agentId?: string;
    sessionId?: string;
    sheetId?: string;
    suiteId?: string;
}
/** Display-only action kept in memory; never serialized into wire/canonical data. */
export interface RuntimeErrorRecoveryAction {
    label: string;
    run: () => void | Promise<void>;
}
export interface RuntimeErrorOptions {
    /** Global errors are rendered by ErrorCenter; diagnostics stay queryable but quiet. */
    visibility?: RuntimeErrorVisibility;
    severity?: RuntimeErrorSeverity;
    scope?: RuntimeErrorScope;
    /** Optional stable operation key when action text is not unique. */
    key?: string;
    technicalMessage?: string;
    metadata?: Readonly<Record<string, unknown>>;
    source?: string;
    recovery?: RuntimeErrorRecovery;
    recoveryAction?: RuntimeErrorRecoveryAction;
}
export interface RuntimeErrorDetail {
    action: string;
    /** Short user-facing summary. Never use this field for unverified timings/raw payloads. */
    message: string;
    /** 后端稳定错误码（施工文档 §5.2）；缺失时保留 undefined。 */
    code?: string;
    /** 可行动恢复入口（ErrorCenter 据此渲染恢复按钮）。 */
    recovery?: RuntimeErrorRecovery;
    severity?: RuntimeErrorSeverity;
    visibility?: RuntimeErrorVisibility;
    scope?: RuntimeErrorScope;
    key?: string;
    /** Bounded, redacted technical detail shown only after expansion. */
    technicalMessage?: string;
    metadata?: Readonly<Record<string, unknown>>;
    source?: string;
    recoveryAction?: RuntimeErrorRecoveryAction;
}
/** 从部署错误码推导恢复入口（施工文档 §5.3 按钮映射）。 */
export declare function recoveryForCode(code: string | undefined, agentId?: string): RuntimeErrorDetail['recovery'];
export declare function formatRuntimeError(action: string, error: unknown, agentId?: string): RuntimeErrorDetail;
export declare function reportRuntimeError(action: string, error: unknown, agentId?: string, options?: RuntimeErrorOptions): RuntimeErrorDetail;
/** Report a real degradation without interrupting the user with a global tray item. */
export declare function reportRuntimeDiagnostic(action: string, error: unknown, agentId?: string, options?: Omit<RuntimeErrorOptions, 'visibility'>): RuntimeErrorDetail;
/** Resolve only matching active entries after a corresponding operation succeeds. */
export declare function resolveRuntimeErrors(matcher: RuntimeErrorMatcher): void;
