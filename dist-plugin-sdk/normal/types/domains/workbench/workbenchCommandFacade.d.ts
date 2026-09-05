export interface WorkbenchAttachment {
    id: string;
    path: string;
    name?: string;
    mediaType?: string;
}
export interface SendCommand {
    text: string;
    attachments?: readonly WorkbenchAttachment[];
    queueIfGenerating?: boolean;
}
export interface SendResult {
    status: 'sent' | 'queued' | 'rejected';
    messageId?: string;
    error?: string;
}
export interface CancelResult {
    status: 'cancelled' | 'not-generating' | 'rejected';
    error?: string;
}
export interface CommandResult {
    ok: boolean;
    error?: string;
}
/**
 * Display-only lifecycle for an empty-state session creation request.
 *
 * Session selection and the first prompt intentionally have different
 * completion boundaries: selecting the local session ends the empty-state
 * creation animation, while the prompt continues through the normal
 * generation footer.  This reader keeps that distinction observable without
 * putting UI state in the canonical journal.
 */
export type WorkbenchSessionCreationPhase = 'idle' | 'creating-session' | 'session-selected' | 'prompt-running' | 'prompt-terminal' | 'creation-failed';
export interface WorkbenchSessionCreationSnapshot {
    readonly phase: WorkbenchSessionCreationPhase;
    readonly sessionId: string | null;
    readonly error: string | null;
    readonly attempt: number;
}
export interface WorkbenchSessionCreationReader {
    getSnapshot(): WorkbenchSessionCreationSnapshot;
    subscribe(listener: () => void): () => void;
}
export interface WorkbenchSessionCreationStore extends WorkbenchSessionCreationReader {
    begin(): number;
    markSessionSelected(attempt: number, sessionId: string): void;
    markPromptRunning(attempt: number, sessionId: string): void;
    markPromptTerminal(attempt: number, sessionId: string): void;
    markFailed(attempt: number, error: string, sessionId?: string | null): void;
}
/** Create a small ephemeral lifecycle store for command/UI coordination. */
export declare function createWorkbenchSessionCreationStore(): WorkbenchSessionCreationStore;
export interface WorkbenchCommandCapabilities {
    readonly prompt?: boolean;
    readonly cancel?: boolean;
    readonly toolAction?: boolean;
    readonly interactionResponse?: boolean;
    readonly resourceOpen?: boolean;
    readonly resourceReveal?: boolean;
    readonly clipboardWrite?: boolean;
    readonly retry?: boolean;
    readonly recovery?: boolean;
    readonly sessionConfig?: boolean;
}
export interface SessionCreateInput {
    title?: string;
    profileId?: string;
    workspaceId?: string;
    model?: string;
    reasoningLevel?: string;
    mode?: string;
    initialPrompt?: SendCommand;
}
export interface SessionCreateResult {
    readonly sessionId: string;
    /** Settles independently after the session-selected boundary. */
    readonly initialPromptOutcome?: Promise<SendResult>;
}
export interface ExportSessionInput {
    format: 'json' | 'markdown';
    destination?: string;
}
export interface WorkbenchCommandFacade {
    /** Optional host-owned reader for the empty-state creation lifecycle. */
    readonly sessionCreation?: WorkbenchSessionCreationReader;
    /** Semantic prompt command; send remains as a compatibility alias. */
    prompt(sessionId: string, command: SendCommand): Promise<SendResult>;
    send(sessionId: string, command: SendCommand): Promise<SendResult>;
    cancel(sessionId: string): Promise<CancelResult>;
    attach(sessionId: string): Promise<readonly WorkbenchAttachment[]>;
    setModel(sessionId: string, modelId: string): Promise<CommandResult>;
    setMode(sessionId: string, modeId: string): Promise<CommandResult>;
    createSession(input?: SessionCreateInput): Promise<SessionCreateResult>;
    compact(sessionId: string): Promise<CommandResult>;
    exportSession(sessionId: string, input: ExportSessionInput): Promise<CommandResult>;
    clearSession(sessionId: string): Promise<CommandResult>;
    setConfigOption(sessionId: string, key: string, value: unknown, options?: {
        expectedValue?: unknown;
        expectedVersion?: number;
    }): Promise<CommandResult>;
    toolAction(sessionId: string, toolCallId: string, action: string, payload?: unknown): Promise<CommandResult>;
    /** C11/A09 补全：expectedRevision 供 transport 层做 stale 写入防护（可省略，向后兼容）。 */
    respondInteraction(sessionId: string, interactionId: string, response: unknown, options?: {
        expectedRevision?: number;
    }): Promise<CommandResult>;
    openResource(sessionId: string, resource: unknown): Promise<CommandResult>;
    revealResource(sessionId: string, resource: unknown): Promise<CommandResult>;
    copy(sessionId: string, text: string): Promise<CommandResult>;
    retry(sessionId: string, messageId?: string): Promise<CommandResult>;
    recover(sessionId: string, strategy?: string): Promise<CommandResult>;
}
/** Keys whose values are callable command methods (excludes optional readers). */
export type WorkbenchCommandMethodKey = {
    [K in keyof WorkbenchCommandFacade]-?: WorkbenchCommandFacade[K] extends (...args: infer _Args) => infer _Result ? K : never;
}[keyof WorkbenchCommandFacade];
export interface WorkbenchCommandCall {
    command: WorkbenchCommandMethodKey;
    args: readonly unknown[];
}
export interface FakeWorkbenchCommandFacade extends WorkbenchCommandFacade {
    readonly calls: readonly WorkbenchCommandCall[];
    setHandler<K extends WorkbenchCommandMethodKey>(command: K, handler: WorkbenchCommandFacade[K]): void;
    reset(): void;
}
export declare function createCapabilityGatedWorkbenchCommandFacade(delegate: WorkbenchCommandFacade, capabilities: WorkbenchCommandCapabilities): WorkbenchCommandFacade;
export declare function createFakeWorkbenchCommandFacade(overrides?: Partial<WorkbenchCommandFacade>): FakeWorkbenchCommandFacade;
