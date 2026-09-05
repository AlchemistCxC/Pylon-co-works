import { type ContentPart, type ContentTruncation, type JsonValue, type SchemaIssue, type SchemaResult } from '../content/contentPartSchema.js';
export type { JsonValue, SchemaIssue, SchemaResult };
export type MessageRole = 'user' | 'assistant' | 'system' | 'tool' | 'reasoning' | 'developer' | 'unknown';
export interface MessageEvent {
    readonly type: 'message.started' | 'message.delta' | 'message.completed';
    readonly role: MessageRole;
    readonly parts?: readonly ContentPart[];
}
export interface ReasoningEvent {
    readonly type: 'reasoning.delta' | 'reasoning.completed' | 'reasoning.redacted';
    readonly parts?: readonly ContentPart[];
    readonly durationMs?: number;
    readonly reason?: string;
}
export interface UnknownSemanticEvent {
    readonly type: 'event.unknown';
    readonly originalType: string;
    readonly summary: string;
    readonly raw: JsonValue;
    readonly truncated: boolean;
    readonly truncation?: ContentTruncation;
}
export interface ExtensionEvent {
    readonly type: 'extension.event';
    readonly kind: `${string}.${string}`;
    readonly payload: JsonValue;
    readonly fallback: readonly ContentPart[];
}
export interface ToolEvent {
    readonly type: 'tool.started' | 'tool.progress' | 'tool.completed' | 'tool.failed';
    readonly tool?: JsonValue;
    readonly progress?: JsonValue;
    readonly parts?: readonly ContentPart[];
    readonly result?: JsonValue;
}
export interface PlanEvent {
    readonly type: 'plan.replaced' | 'plan.entry-updated';
    readonly entries?: readonly JsonValue[];
    readonly entry?: JsonValue;
}
export interface GoalEvent {
    readonly type: 'goal.updated' | 'goal.cleared';
    readonly goal?: JsonValue;
    readonly goalId?: string;
}
export declare const ACTIVITY_STATUSES: readonly ["pending", "starting", "running", "paused", "completed", "failed", "interrupted", "cancel-requested", "cancelled", "timeout", "blocked", "unknown"];
export type ActivityStatus = (typeof ACTIVITY_STATUSES)[number];
export declare function isActivityStatus(value: unknown): value is ActivityStatus;
export interface ActivityEvent {
    readonly type: 'activity.started' | 'activity.progress' | 'activity.completed' | 'activity.failed' | 'activity.cancelled';
    readonly activity?: JsonValue;
    readonly activityId?: string;
    readonly patch?: JsonValue;
    readonly result?: JsonValue;
    readonly error?: JsonValue;
    readonly reason?: string;
}
export interface InteractionEvent {
    readonly type: 'interaction.requested' | 'interaction.resolved' | 'interaction.expired';
    readonly interactionId: string;
    readonly request?: JsonValue;
    readonly response?: JsonValue;
    readonly reason?: string;
}
export interface UsageEvent {
    readonly type: 'usage.updated' | 'budget.warning';
    readonly usage?: JsonValue;
    readonly used?: number;
    readonly limit?: number;
    readonly threshold?: string;
    readonly percent?: number;
    readonly remaining?: number;
    readonly budgetType?: string;
    readonly resetAt?: string;
    readonly exhausted?: boolean;
}
export interface SessionEvent {
    readonly type: 'session.started' | 'session.commands-updated' | 'session.config-updated' | 'session.model-updated' | 'session.mode-updated' | 'session.status-updated' | 'session.completed';
    readonly cwd?: string;
    readonly model?: string;
    readonly mode?: string;
    readonly status?: string;
    readonly commands?: readonly JsonValue[];
    readonly options?: readonly JsonValue[];
    readonly stopReason?: string;
}
export interface LifecycleEvent {
    readonly type: 'lifecycle.retrying' | 'lifecycle.compact-started' | 'lifecycle.compact-completed' | 'lifecycle.rewind-preview' | 'lifecycle.rewind-completed' | 'lifecycle.suspended' | 'lifecycle.recovered';
    readonly attempt?: number;
    readonly maxAttempts?: number;
    readonly delayMs?: number;
    readonly error?: JsonValue;
    readonly strategy?: string;
    readonly trigger?: string;
    /** C13：compact 前后 token 与 rewind 文件/消息预览（总纲 4.4 lifecycle 字段） */
    readonly tokensBefore?: number;
    readonly tokensAfter?: number;
    readonly summary?: string;
    readonly importedEvents?: number;
    readonly files?: readonly JsonValue[];
    readonly messages?: readonly JsonValue[];
    readonly source?: 'canonical' | 'agent-import';
    readonly reason?: string;
}
export interface AssistEvent {
    readonly type: 'assist.prediction' | 'assist.file-suggestions' | 'assist.queued-command';
    readonly placeholder?: string;
    readonly actions?: readonly JsonValue[];
    readonly files?: readonly string[];
    readonly command?: string;
}
export interface DiagnosticEvent {
    readonly type: 'diagnostic.updated' | 'diagnostic.notice';
    readonly diagnostics?: readonly JsonValue[];
    readonly level?: 'info' | 'warning' | 'error';
    readonly message?: string;
    readonly code?: string;
    /** Optional structured detail kept behind the default user-facing summary. */
    readonly data?: JsonValue;
}
export type WorkbenchSemanticEvent = MessageEvent | ReasoningEvent | ToolEvent | PlanEvent | GoalEvent | ActivityEvent | InteractionEvent | UsageEvent | SessionEvent | LifecycleEvent | AssistEvent | DiagnosticEvent | UnknownSemanticEvent | ExtensionEvent;
export type ProvenanceOrigin = 'local-observed' | 'optimistic-local' | 'recovery-import' | 'migration' | 'plugin';
export type ProvenanceTrust = 'authoritative' | 'unverified';
export interface WorkbenchEventSource {
    readonly provider: string;
    readonly sourceId: string;
    readonly agentId?: string;
    readonly parentAgentId?: string;
}
export interface WorkbenchEventIdentity {
    readonly turnId?: string;
    readonly messageId?: string;
    readonly toolCallId?: string;
    readonly taskId?: string;
    readonly runId?: string;
    readonly interactionId?: string;
}
export interface WorkbenchEventProvenance {
    readonly origin: ProvenanceOrigin;
    readonly trust: ProvenanceTrust;
    readonly provider?: string;
    readonly importId?: string;
    readonly sourceOrdinal?: number;
    readonly orderConfidence?: 'exact' | 'observed' | 'grouped' | 'unknown';
    readonly collectionComplete?: boolean;
    readonly synthetic?: {
        readonly reason: string;
    };
}
export interface WorkbenchRawMetadata extends ContentTruncation {
    readonly redactions?: readonly {
        readonly path: readonly (string | number)[];
        readonly reason: 'sensitive';
    }[];
}
export interface WorkbenchEventEnvelope {
    readonly schemaVersion: 1;
    readonly eventId: string;
    readonly sessionId: string;
    readonly sequence: number;
    readonly recordedAt: string;
    readonly occurredAt?: string;
    readonly source: WorkbenchEventSource;
    readonly identity: WorkbenchEventIdentity;
    readonly provenance: WorkbenchEventProvenance;
    readonly event: WorkbenchSemanticEvent;
    readonly raw?: JsonValue;
    readonly rawMetadata?: WorkbenchRawMetadata;
}
export type WorkbenchEnvelopeInput = Omit<WorkbenchEventEnvelope, 'schemaVersion' | 'eventId' | 'identity' | 'raw' | 'rawMetadata'> & {
    readonly eventId?: string;
    readonly identity?: WorkbenchEventIdentity;
    readonly raw?: unknown;
    readonly rawMaxBytes?: number;
};
export interface MigrationIssue extends SchemaIssue {
    readonly code: string;
}
export declare function createWorkbenchEnvelope(input: WorkbenchEnvelopeInput): WorkbenchEventEnvelope;
export declare function deriveWorkbenchEventId(input: Pick<WorkbenchEventEnvelope, 'sessionId' | 'sequence' | 'source' | 'identity' | 'event'>): string;
export declare function parseWorkbenchEnvelope(value: unknown): SchemaResult<WorkbenchEventEnvelope>;
export declare function migrateWorkbenchEnvelope(value: unknown): SchemaResult<WorkbenchEventEnvelope>;
