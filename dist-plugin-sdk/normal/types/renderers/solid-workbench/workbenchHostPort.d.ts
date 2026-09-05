import type { AppearanceCommand, WorkbenchAppearanceSnapshot, WorkbenchAppearanceStore } from '../../domains/workbench/appearance.js';
import type { SessionUiKey, SessionUiScope, SessionUiStore } from '../../domains/workbench/sessionUiStore.js';
import type { WorkbenchCommandFacade, SendCommand, SendResult, CancelResult, WorkbenchAttachment, SessionCreateInput, SessionCreateResult, ExportSessionInput, CommandResult, WorkbenchSessionCreationReader } from '../../domains/workbench/workbenchCommandFacade.js';
import type { WorkbenchDocument, WorkbenchMessage, WorkbenchActivityNode, WorkbenchInteraction, WorkbenchTimelineEntry } from '../../domains/workbench/workbenchProjector.js';
import type { WorkbenchRuntime, WorkbenchRuntimeSnapshot } from '../../domains/workbench/workbenchRuntime.js';
import type { RenderAppearanceSnapshot } from '../../contracts/messageRenderer.js';
import type { GenerationActivitySnapshot } from '../../domains/workbench/generationFooterContracts.js';
import type { InputPredictionProvider } from './input/inputPredictionProvider.js';
export type WorkbenchDocumentSlice = 'document' | 'timeline' | 'messages' | 'activities' | 'interactions' | 'extensions' | 'session' | 'usage' | 'config' | 'commands' | 'assist' | 'diagnostics';
export interface WorkbenchDocumentReader {
    getSnapshot(): WorkbenchDocument | undefined;
    subscribe(listener: () => void): () => void;
    getSlice<T = unknown>(slice: WorkbenchDocumentSlice): T;
    subscribeSlice(slice: WorkbenchDocumentSlice, listener: () => void): () => void;
}
export type WorkbenchGenerationSnapshot = Readonly<Pick<WorkbenchRuntimeSnapshot, 'generating' | 'generationStart' | 'lastTokenAt' | 'generationPhase' | 'thinkingStart' | 'tokenCount' | 'summary'> & {
    generationActivity?: GenerationActivitySnapshot;
    revision?: number;
    turnEpoch?: number;
    terminalFence?: WorkbenchRuntimeSnapshot['terminalFence'];
}>;
/** Session-scoped ephemeral state that cannot be reconstructed from persisted transcript rows. */
export interface WorkbenchGenerationReader {
    getSnapshot(): WorkbenchGenerationSnapshot;
    subscribe(listener: () => void): () => void;
}
export interface ResolvedAppearanceReader {
    getSnapshot(): WorkbenchAppearanceSnapshot;
    subscribe(listener: () => void): () => void;
    /** Host-gated mutation seam; absent/false means the Suite is read-only. */
    dispatch?(command: AppearanceCommand): boolean;
    resolve?(request: {
        readonly kind: string;
        readonly suiteId: string;
        readonly slotId: string;
    }): RenderAppearanceSnapshot;
}
export interface SessionUiPort {
    get<T>(key: SessionUiKey, fallback: T): T;
    set<T>(key: SessionUiKey, value: T): void;
    update<T>(key: SessionUiKey, fallback: T, updater: (previous: T) => T): T;
    subscribe(key: SessionUiKey, listener: () => void): () => void;
    capture(): SessionUiScope;
    clear(): void;
}
export type WorkbenchCapability = 'prompt' | 'cancel' | 'attach' | 'model' | 'mode' | 'sessionCreate' | 'compact' | 'sessionExport' | 'sessionClear' | 'sessionConfig' | 'toolAction' | 'interactionResponse' | 'resourceOpen' | 'resourceReveal' | 'clipboardWrite' | 'retry' | 'recovery' | 'appearanceEdit';
export type WorkbenchCapabilitySnapshot = Readonly<Partial<Record<WorkbenchCapability, boolean>>>;
export interface WorkbenchCapabilityReader {
    getSnapshot(): WorkbenchCapabilitySnapshot;
    has(capability: WorkbenchCapability): boolean;
    subscribe(listener: () => void): () => void;
}
export type WorkbenchRecoverability = 'retry' | 'fallback' | 'reload-plugin' | 'reimport' | 'none';
export interface WorkbenchCommandError {
    readonly code: string;
    readonly message: string;
    readonly recoverability: WorkbenchRecoverability;
    readonly capability?: WorkbenchCapability;
}
export type WorkbenchCommandResult<T> = {
    readonly ok: true;
    readonly value: T;
} | {
    readonly ok: false;
    readonly error: WorkbenchCommandError;
};
export interface WorkbenchCommandPort {
    prompt(sessionId: string, command: SendCommand): Promise<WorkbenchCommandResult<SendResult>>;
    send(sessionId: string, command: SendCommand): Promise<WorkbenchCommandResult<SendResult>>;
    cancel(sessionId: string): Promise<WorkbenchCommandResult<CancelResult>>;
    attach(sessionId: string): Promise<WorkbenchCommandResult<readonly WorkbenchAttachment[]>>;
    setModel(sessionId: string, modelId: string): Promise<WorkbenchCommandResult<CommandResult>>;
    setMode(sessionId: string, modeId: string): Promise<WorkbenchCommandResult<CommandResult>>;
    createSession(input?: SessionCreateInput): Promise<WorkbenchCommandResult<SessionCreateResult>>;
    compact(sessionId: string): Promise<WorkbenchCommandResult<CommandResult>>;
    exportSession(sessionId: string, input: ExportSessionInput): Promise<WorkbenchCommandResult<CommandResult>>;
    clearSession(sessionId: string): Promise<WorkbenchCommandResult<CommandResult>>;
    setConfigOption(sessionId: string, key: string, value: unknown, options?: {
        expectedValue?: unknown;
        expectedVersion?: number;
    }): Promise<WorkbenchCommandResult<CommandResult>>;
    toolAction(sessionId: string, toolCallId: string, action: string, payload?: unknown): Promise<WorkbenchCommandResult<CommandResult>>;
    respondInteraction(sessionId: string, interactionId: string, response: unknown, options?: {
        expectedRevision?: number;
    }): Promise<WorkbenchCommandResult<CommandResult>>;
    openResource(sessionId: string, resource: unknown): Promise<WorkbenchCommandResult<CommandResult>>;
    revealResource(sessionId: string, resource: unknown): Promise<WorkbenchCommandResult<CommandResult>>;
    copy(sessionId: string, text: string): Promise<WorkbenchCommandResult<CommandResult>>;
    retry(sessionId: string, messageId?: string): Promise<WorkbenchCommandResult<CommandResult>>;
    recover(sessionId: string, strategy?: string): Promise<WorkbenchCommandResult<CommandResult>>;
}
export interface RendererDiagnosticContext {
    readonly code: string;
    readonly message: string;
    readonly phase?: 'resolve' | 'prepare' | 'mount' | 'update' | 'switch' | 'action' | 'destroy' | 'settings-migrate';
    readonly pluginId?: string;
    readonly runtimeInstanceId?: string;
    readonly suiteId?: string;
    readonly slotId?: string;
    readonly kind?: string;
    readonly eventId?: string;
    readonly sessionId?: string | null;
    readonly recoverability?: WorkbenchRecoverability;
    readonly [key: string]: unknown;
}
export interface RendererDiagnosticPort {
    report(diagnostic: RendererDiagnosticContext): void;
    getRecent(): readonly RendererDiagnosticContext[];
    subscribe(listener: () => void): () => void;
    destroy?(): void;
}
export interface WorkbenchHostPort {
    readonly document: WorkbenchDocumentReader;
    readonly generation: WorkbenchGenerationReader;
    readonly appearance: ResolvedAppearanceReader;
    readonly sessionUi: SessionUiPort;
    readonly commands: WorkbenchCommandPort;
    /** Display-only empty-state creation lifecycle; never persisted as a fact. */
    readonly sessionCreation?: WorkbenchSessionCreationReader;
    readonly capabilities: WorkbenchCapabilityReader;
    readonly diagnostics: RendererDiagnosticPort;
    /** Optional host-owned local/remote provider for input prediction. */
    readonly predictionProvider?: InputPredictionProvider;
}
export interface WorkbenchHostPortInput {
    readonly runtime: WorkbenchRuntime;
    readonly appearance: WorkbenchAppearanceStore;
    readonly sessionUi: SessionUiStore;
    readonly commands: WorkbenchCommandFacade;
    readonly suiteId: string;
    readonly sheetId: string;
    readonly sessionOwnerKey: string | null;
    readonly sessionId: string | null;
    readonly capabilities?: WorkbenchCapabilitySnapshot;
    readonly diagnostics?: ((diagnostic: RendererDiagnosticContext) => void) | Pick<RendererDiagnosticPort, 'report'>;
    readonly predictionProvider?: InputPredictionProvider;
    readonly renderAppearance?: {
        resolve(request: {
            readonly kind: string;
            readonly suiteId: string;
            readonly slotId: string;
        }, host: WorkbenchAppearanceSnapshot): RenderAppearanceSnapshot;
        subscribe(listener: () => void): () => void;
    };
    /** Stable Host Port may follow session/Suite changes without replacing renderer instances. */
    readonly binding?: () => {
        readonly suiteId?: string;
        readonly sheetId: string;
        readonly sessionOwnerKey: string | null;
        readonly sessionId: string | null;
    };
}
/** Public adapter used by Suite implementations and isolated-surface bridges. */
export declare function createWorkbenchCommandPort(delegate: WorkbenchCommandFacade, capabilities: WorkbenchCapabilityReader): WorkbenchCommandPort;
export declare function createWorkbenchHostPort(input: WorkbenchHostPortInput): WorkbenchHostPort;
export type WorkbenchDocumentReaderValue = WorkbenchDocument | undefined;
export type WorkbenchDocumentMessage = WorkbenchMessage;
export type WorkbenchDocumentActivity = WorkbenchActivityNode;
export type WorkbenchDocumentInteraction = WorkbenchInteraction;
export type WorkbenchDocumentTimeline = WorkbenchTimelineEntry;
