import type { WorkbenchAppearanceStore } from '../../domains/workbench/appearance.js';
import type { SessionUiStore } from '../../domains/workbench/sessionUiStore.js';
import type { WorkbenchCommandFacade } from '../../domains/workbench/workbenchCommandFacade.js';
import type { WorkbenchRuntime } from '../../domains/workbench/workbenchRuntime.js';
import type { WorkbenchHostPort } from './workbenchHostPort.js';
import type { RendererActivationSnapshot } from '../../plugin-runtime/renderers/rendererSuiteTypes.js';
import type { InputPredictionProvider } from './input/inputPredictionProvider.js';
export type { WorkbenchHostPort, WorkbenchCommandPort, WorkbenchCommandResult, WorkbenchCommandError, WorkbenchDocumentReader, WorkbenchGenerationReader, ResolvedAppearanceReader, SessionUiPort, WorkbenchCapabilityReader, RendererDiagnosticPort, } from './workbenchHostPort.js';
export interface SolidWorkbenchServices {
    runtime: WorkbenchRuntime;
    appearance: WorkbenchAppearanceStore;
    sessionUi: SessionUiStore;
    commands: WorkbenchCommandFacade;
    /** Stable framework-neutral seam consumed by Suite adapters. */
    hostPort?: WorkbenchHostPort;
    /** Optional host-owned local/remote provider for low-frequency input prediction. */
    predictionProvider?: InputPredictionProvider;
}
export interface WorkbenchMountInput {
    readonly sheetId: string;
    readonly sessionOwnerKey: string | null;
    readonly sessionId: string | null;
    readonly workspaceMode: 'work' | 'chat';
    readonly replayReadonly: boolean;
    readonly reducedMotion: boolean;
    readonly visibility: 'active' | 'background';
    readonly rightInset: number;
    readonly preview: boolean;
    readonly presentationProfileId?: string;
    readonly sessionLabel?: string;
    readonly workspaceLabel?: string;
    readonly workspacePath?: string;
    readonly availableWorkspaces?: readonly WorkbenchWorkspaceOption[];
}
export interface WorkbenchWorkspaceOption {
    readonly id: string;
    readonly label: string;
    readonly path: string;
    readonly lastActiveAt?: number;
}
export interface RendererPrepareContext {
    readonly suiteId: string;
    readonly host: WorkbenchHostPort;
    readonly activation: RendererActivationSnapshot;
}
export interface WorkbenchRendererFactory {
    prepare(context: RendererPrepareContext): Promise<PreparedWorkbenchRenderer>;
}
export interface PreparedWorkbenchRenderer {
    mount(container: HTMLElement, input: WorkbenchMountInput, host: WorkbenchHostPort): Promise<WorkbenchRendererInstance> | WorkbenchRendererInstance;
}
export interface WorkbenchRendererInstance {
    update(input: WorkbenchMountInput): void;
    pause(): void;
    resume(): void;
    destroy(): void | Promise<void>;
    on(event: 'ready' | 'error' | 'request-action', listener: (payload: unknown) => void): () => void;
}
export interface SolidWorkbenchInput {
    sheetId: string;
    sessionId: string | null;
    replayReadonly?: boolean;
    rightInset?: number;
    preview?: boolean;
    reducedMotion?: boolean;
    sessionOwnerKey?: string | null;
    workspaceMode?: 'work' | 'chat';
    visibility?: 'active' | 'background';
    presentationProfileId?: string;
    sessionLabel?: string;
    workspaceLabel?: string;
    workspacePath?: string;
    availableWorkspaces?: readonly WorkbenchWorkspaceOption[];
}
export declare function normalizeWorkbenchMountInput(input: SolidWorkbenchInput): WorkbenchMountInput;
export interface SolidWorkbenchLifecycle {
    update(input: SolidWorkbenchInput): void;
    pause(): void;
    resume(): void;
    destroy(): void | Promise<void>;
    on(event: 'ready' | 'error' | 'request-action', listener: (payload: unknown) => void): () => void;
}
export interface SolidWorkbenchMountInput {
    host: HTMLElement;
    input: SolidWorkbenchInput;
    services: SolidWorkbenchServices;
    hostPort?: WorkbenchHostPort;
}
