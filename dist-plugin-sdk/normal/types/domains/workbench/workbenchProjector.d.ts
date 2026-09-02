/**
 * A04：唯一 Workbench projector。
 *
 * 这是一个 deep pure module：输入已经归一化、带 sequence 的 semantic envelope，
 * 输出可丢弃的 WorkbenchDocument。它不读取时钟、store、registry 或 IO；live、
 * restart、recovery 只要喂给同一组 envelopes，就得到同一份 document。
 */
import { type ContentPart } from './content/contentPartSchema.js';
import { type GoalSnapshot, type GoalState, type PlanState } from './plan/goalModel.js';
import { type LifecycleState, type NormalizedError } from './lifecycle/lifecycleModel.js';
import type { ExtensionEvent, WorkbenchEventEnvelope } from './events/workbenchEventSchema.js';
import { type AssistSnapshot, type SessionCommand, type SessionConfigOption, type UsageSnapshot } from './session/sessionSurface.js';
export type WorkbenchTimelineKind = 'message' | 'reasoning' | 'tool' | 'activity' | 'interaction' | 'session' | 'usage' | 'plan' | 'lifecycle' | 'diagnostic' | 'extension' | 'unknown' | 'assist';
export interface WorkbenchTimelineEntry {
    readonly id: string;
    readonly sequence: number;
    readonly eventId: string;
    readonly kind: WorkbenchTimelineKind;
    readonly status?: string;
    readonly title?: string;
    readonly summary?: string;
    /** First semantic occurrence of an activity that splits adjacent text streams. */
    readonly streamBoundary?: boolean;
    readonly data?: unknown;
}
export interface WorkbenchMessage {
    /** Session-scoped render key. Never reuse a provider message/turn id as a row key. */
    readonly id: string;
    /** Replay-stable identity of this projected text segment (the opening canonical event id). */
    readonly segmentId: string;
    readonly role: 'user' | 'assistant' | 'reasoning';
    readonly content: string;
    readonly parts: readonly ContentPart[];
    readonly identity: WorkbenchEventEnvelope['identity'];
    readonly source: WorkbenchEventEnvelope['source'];
    /** Temporary local echo marker used only until the authoritative user row arrives. */
    readonly optimistic?: boolean;
    readonly sequence: number;
    readonly running: boolean;
    readonly time: string;
    /** C01：reasoning 完成/redacted 时记录的思考时长（首 delta → 终态 occurredAt）。 */
    readonly thoughtDurationMs?: number;
    /** C01：provider 隐去推理标记——渲染层据此显示安全占位，不显示正文。 */
    readonly redacted?: boolean;
    /** C01：隐去原因（provider 原样透传，缺失时 undefined）。 */
    readonly redactedReason?: string;
    /** C01：内部字段——本段 reasoning 首个 delta 的 occurredAt（ms），用于终态计算 duration；不进渲染。 */
    readonly thoughtStartedAtMs?: number;
}
export interface WorkbenchActivityNode {
    readonly id: string;
    readonly kind: 'tool' | 'activity';
    /** Renderer semantic kind copied from normalized payload; never derived from provider raw. */
    readonly semanticKind?: string;
    /** Provider-neutral activity family (for example process/background-task). */
    readonly activityKind?: string;
    readonly title?: string;
    readonly status: string;
    readonly parentId?: string;
    /** C09：创建该节点的 normalized agent identity；不从 parent/title 推断。 */
    readonly sourceAgentId?: string;
    readonly description?: string;
    readonly startedAt?: string;
    readonly completedAt?: string;
    /** C07：后台执行身份；仅来自 normalized activity payload/patch。 */
    readonly processId?: string;
    readonly sessionId?: string;
    /** C04：canonical machine name（_meta.pylon.toolName 优先的归一结果）。 */
    readonly canonicalName?: string;
    /** C04：normalized input（renderer 消费字段；rawInput 只作审计兼容留在 data/rawOutput 侧）。 */
    readonly input?: unknown;
    /** C04：normalized locations（文件/行范围数组）。 */
    readonly locations?: unknown;
    /** C04：最近一次 provider-neutral progress 快照；终态到达后仍保留。 */
    readonly progress?: unknown;
    /** C04：provider-neutral action（read/write/execute/…）。 */
    readonly action?: string;
    /** C04：capability snapshot（如 ['fs','mcp','dynamic-schema']）。 */
    readonly capabilities?: unknown;
    /** C04：父工具调用 id（子代理/嵌套工具关系，semantic parent）。 */
    readonly parentToolCallId?: string;
    /** C04：终态耗时（ms），由 completed/redacted 终态事件携带。 */
    readonly durationMs?: number;
    /** C04：failed/cancelled 的结构化错误摘要。 */
    readonly error?: NormalizedError;
    /** C04：result parts（ContentPart 数组，renderer 递归渲染）。 */
    readonly parts?: unknown;
    /** C04：审计兼容原始输出（不进 UI 主路径）。 */
    readonly rawOutput?: unknown;
    /** C04：wire 原始工具名（generic 卡显示；与展示 title 分离）。 */
    readonly providerName?: string;
    /** C04：审计兼容原始 input（不进 UI 主路径）。 */
    readonly rawInput?: unknown;
    /** C04：wire kind（ACP kind 字段直通）。 */
    readonly toolKindWire?: string;
    /** C04：本地化显示标题（title 直通；不作为身份）。 */
    readonly displayName?: string;
    /** C07：activity terminal result and cancellation reason remain separate from message history. */
    readonly result?: unknown;
    /** C10：progress patch termination evidence; never inferred from transcript text. */
    readonly killed?: boolean;
    readonly timeout?: boolean;
    /** C09：schema-validated activity output consumed by renderers. */
    readonly output?: readonly ContentPart[];
    readonly reason?: string;
    readonly provenance?: WorkbenchEventEnvelope['provenance'];
    /** C09：子代理层级深度（来自 normalized payload，不从文本猜）。 */
    readonly depth?: number;
    /** C09：子代理角色（如 explorer/reviewer）。 */
    readonly role?: string;
    /** C09：执行模型与 provider（显示用，非身份）。 */
    readonly model?: string;
    readonly provider?: string;
    /** C09：目标/prompt 摘要。 */
    readonly goal?: string;
    /** C09：usage/cost 与文件清单等聚合指标（JsonValue 宽容）。 */
    readonly usage?: unknown;
    readonly metrics?: unknown;
    readonly files?: unknown;
    /** C09：local/remote/background/worktree/team 等 provider-neutral execution metadata。 */
    readonly execution?: unknown;
    readonly tools?: unknown;
    readonly tasks?: unknown;
    readonly metadata?: unknown;
    readonly orphan: boolean;
    readonly data?: unknown;
    readonly sequence: number;
}
export interface WorkbenchInteraction {
    readonly id: string;
    readonly status: 'requested' | 'resolved' | 'expired';
    readonly request?: unknown;
    readonly response?: unknown;
    readonly reason?: string;
    readonly sequence: number;
}
export interface WorkbenchSessionSurface {
    readonly status: string;
    readonly stopReason?: string;
    readonly model?: string;
    readonly mode?: string;
    readonly commands: readonly SessionCommand[];
    readonly options: readonly SessionConfigOption[];
    readonly usage?: UsageSnapshot;
}
export interface WorkbenchProjectionDiagnostic {
    readonly code: string;
    readonly message: string;
    readonly eventId: string;
    readonly sequence: number;
    readonly level: 'info' | 'warning' | 'error';
    readonly data?: unknown;
}
/** Canonical negotiated extension event projected into the disposable document. */
export interface WorkbenchExtensionNode {
    readonly id: string;
    readonly kind: ExtensionEvent['kind'];
    readonly payload: ExtensionEvent['payload'];
    readonly fallback: ExtensionEvent['fallback'];
    readonly identity: WorkbenchEventEnvelope['identity'];
    readonly source: WorkbenchEventEnvelope['source'];
    readonly provenance: WorkbenchEventEnvelope['provenance'];
    readonly sequence: number;
    readonly time: string;
}
export interface WorkbenchDocument {
    readonly sessionId: string;
    readonly revision: number;
    readonly appliedEventIds: readonly string[];
    readonly timeline: readonly WorkbenchTimelineEntry[];
    readonly messages: readonly WorkbenchMessage[];
    readonly activities: readonly WorkbenchActivityNode[];
    readonly interactions: readonly WorkbenchInteraction[];
    readonly extensions: readonly WorkbenchExtensionNode[];
    readonly session: WorkbenchSessionSurface;
    readonly assist: AssistSnapshot;
    readonly diagnostics: readonly WorkbenchProjectionDiagnostic[];
    readonly plan: PlanState;
    readonly goal: GoalState;
    /** C13：生命周期当前态 + 历史（恢复成功不删除历史事实） */
    readonly lifecycle: LifecycleState;
    /** C13：system.error 级结构化错误（NormalizedError），与普通 notice 分离 */
    readonly systemErrors: readonly NormalizedError[];
}
export interface ProjectionResult {
    readonly document: WorkbenchDocument;
    readonly diagnostics: readonly WorkbenchProjectionDiagnostic[];
}
export declare function createWorkbenchDocument(sessionId: string): WorkbenchDocument;
export declare function reduceWorkbenchEvent(document: WorkbenchDocument, envelope: WorkbenchEventEnvelope): WorkbenchDocument;
export declare function projectWorkbench(events: readonly WorkbenchEventEnvelope[], options?: {
    readonly initialDocument?: WorkbenchDocument;
}): ProjectionResult;
export declare function selectTimeline(document: WorkbenchDocument): readonly WorkbenchTimelineEntry[];
export declare function selectActivities(document: WorkbenchDocument): readonly WorkbenchActivityNode[];
/** C09：按 identity parent edge 派生稳定展示顺序；journal/document 本身保持原序。 */
export declare function selectActivityDisplayOrder(document: WorkbenchDocument): readonly WorkbenchActivityNode[];
/** C11：全部 interaction 列表（requested/resolved/expired 均可见，供历史审计与 fallback）。 */
export declare function selectInteractions(document: WorkbenchDocument): readonly WorkbenchInteraction[];
/** C11：待处理 interaction 队列（renderer 卡片消费；重复 response 幂等由 reducer 保证）。 */
export declare function selectPendingInteractions(document: WorkbenchDocument): readonly WorkbenchInteraction[];
/** C04：工具调用 provider-neutral snapshot（renderer 消费的唯一形态）。 */
export interface ToolInvocationSnapshot {
    readonly id: string;
    /** 展示名（wire title 直通；缺失时 undefined，由 generic 卡显示 provider name）。 */
    readonly title?: string;
    /** canonical machine name（_meta.pylon.toolName 优先）。 */
    readonly canonicalName?: string;
    /** wire 原始 name（generic 卡的 provider name 显示）。 */
    readonly name?: string;
    readonly semanticKind?: string;
    readonly kind?: string;
    readonly action?: string;
    readonly capabilities?: unknown;
    /** normalized input（renderer 消费字段）。 */
    readonly input?: unknown;
    /** 审计兼容原始 input（不进 UI 主路径）。 */
    readonly rawInput?: unknown;
    readonly locations?: unknown;
    readonly status?: string;
    readonly progress?: unknown;
    readonly parentToolCallId?: string;
    readonly result?: {
        readonly status?: string;
        readonly parts?: unknown;
        readonly rawOutput?: unknown;
        readonly error?: NormalizedError;
        readonly durationMs?: number;
    };
}
/**
 * C04 架构补全：从 document activities 收窄出 typed 工具调用快照。
 * 缺字段保持 undefined（不伪造空值/零值）；未知 id 返回 null。
 */
export declare function toolInvocationSnapshot(document: WorkbenchDocument, toolCallId: string): ToolInvocationSnapshot | null;
export declare function selectSessionSurface(document: WorkbenchDocument): WorkbenchSessionSurface;
export declare function selectAssist(document: WorkbenchDocument): AssistSnapshot;
/** C08：plan/goal slice 只读选择器。 */
export declare function selectPlan(document: WorkbenchDocument): PlanState;
export declare function selectGoal(document: WorkbenchDocument): GoalSnapshot | undefined;
/** C13：生命周期 slice 与 system error 只读选择器。 */
export declare function selectLifecycle(document: WorkbenchDocument): LifecycleState;
export declare function selectSystemErrors(document: WorkbenchDocument): readonly NormalizedError[];
export declare function selectExtensions(document: WorkbenchDocument): readonly WorkbenchExtensionNode[];
