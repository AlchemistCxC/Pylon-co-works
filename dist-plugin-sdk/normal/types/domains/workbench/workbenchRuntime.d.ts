import type { Message } from '../../components/chat/messageTypes.js';
import type { PlanEntry } from '../tasks/planTypes.js';
import { type PlanEntryV2 } from './plan/goalModel.js';
import type { GenerationActivitySnapshot, GenerationPhase, GenerationSummary } from './generationFooterContracts.js';
import type { WorkbenchDocument } from './workbenchProjector.js';
export type WorkbenchRuntimeStatus = 'idle' | 'loading' | 'ready' | 'degraded' | 'error';
/** Legacy chat plan rows and canonical C08 plan rows coexist only at the runtime adapter boundary. */
export type WorkbenchTaskEntry = PlanEntry | PlanEntryV2;
export type WorkbenchRuntimeSlice = 'document' | 'timeline' | 'messages' | 'activities' | 'interactions' | 'session' | 'usage' | 'plan' | 'goal' | 'assist' | 'diagnostics' | 'extensions' | 'config' | 'commands' | 'tasks' | 'streaming' | 'capabilities';
export interface WorkbenchRuntimeSnapshot {
    revision: number;
    sessionId: string | null;
    /** Session owner identity used to reject late events after a session switch. */
    ownerKey?: string;
    /** Agent/runtime generation associated with the current owner. */
    generation?: number;
    status: WorkbenchRuntimeStatus;
    messages: readonly Message[];
    streamingText: string;
    streamingThinking: string;
    generating: boolean;
    generationPhase?: GenerationPhase;
    /** 活动轴；旧 generationPhase 仍作为兼容投影保留。 */
    generationActivity?: GenerationActivitySnapshot;
    generationStart: number;
    lastTokenAt?: number;
    tokenCount: number;
    summary: GenerationSummary | null;
    tasks: readonly WorkbenchTaskEntry[];
    thinkingStart?: number;
    availableModels: readonly string[];
    activeModel: string;
    availableModes: readonly string[];
    activeMode: string;
    canAttach: boolean;
    promptImage: boolean;
    error: string | null;
    /** A04 projection view; legacy fields remain compatibility selectors for the current Solid adapter. */
    document?: WorkbenchDocument;
}
export interface WorkbenchRuntime {
    getSnapshot(): WorkbenchRuntimeSnapshot;
    subscribe(listener: () => void): () => void;
    getSlice<T = unknown>(slice: WorkbenchRuntimeSlice): T;
    subscribeSlice(slice: WorkbenchRuntimeSlice, listener: () => void): () => void;
}
export interface PreviewWorkbenchRuntime extends WorkbenchRuntime {
    setSnapshot(snapshot: WorkbenchRuntimeSnapshot): void;
    update(patch: Partial<Omit<WorkbenchRuntimeSnapshot, 'revision'>>): void;
    destroy(): void;
    applyDocument(document: WorkbenchDocument, options?: WorkbenchDocumentApplyOptions): void;
    replaceDocument(document: WorkbenchDocument, options?: WorkbenchDocumentApplyOptions): void;
}
export interface WorkbenchDocumentApplyOptions {
    /** Owner key is stable for one session binding (agent + source + session). */
    readonly ownerKey?: string;
    /** Lower generations are stale and are ignored once a newer one is active. */
    readonly generation?: number;
    /** replaceDocument may explicitly clear the active session. */
    readonly sessionId?: string | null;
    /**
     * Keep the host-owned generation clock while applying a document projection.
     * The canonical document and the live controller are separate streams; a
     * projection can briefly omit running rows (or their timestamps) while a
     * turn is still active.  Callers that own an authoritative live generation
     * reader set this flag so that gap cannot reset elapsed time.
     */
    readonly preserveGeneration?: boolean;
}
/** Mutable document runtime used by production composition and preview fixtures. */
export declare function createWorkbenchRuntime(initial: Omit<WorkbenchRuntimeSnapshot, 'revision'>): PreviewWorkbenchRuntime;
/** Preview compatibility name; production callers use createWorkbenchRuntime. */
export declare function createPreviewWorkbenchRuntime(initial: Omit<WorkbenchRuntimeSnapshot, 'revision'>): PreviewWorkbenchRuntime;
