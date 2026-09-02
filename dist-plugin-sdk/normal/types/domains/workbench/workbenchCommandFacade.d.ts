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
export interface ExportSessionInput {
    format: 'json' | 'markdown';
    destination?: string;
}
export interface WorkbenchCommandFacade {
    /** Semantic prompt command; send remains as a compatibility alias. */
    prompt(sessionId: string, command: SendCommand): Promise<SendResult>;
    send(sessionId: string, command: SendCommand): Promise<SendResult>;
    cancel(sessionId: string): Promise<CancelResult>;
    attach(sessionId: string): Promise<readonly WorkbenchAttachment[]>;
    setModel(sessionId: string, modelId: string): Promise<CommandResult>;
    setMode(sessionId: string, modeId: string): Promise<CommandResult>;
    createSession(input?: SessionCreateInput): Promise<{
        sessionId: string;
    }>;
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
export interface WorkbenchCommandCall {
    command: keyof WorkbenchCommandFacade;
    args: readonly unknown[];
}
export interface FakeWorkbenchCommandFacade extends WorkbenchCommandFacade {
    readonly calls: readonly WorkbenchCommandCall[];
    setHandler<K extends keyof WorkbenchCommandFacade>(command: K, handler: WorkbenchCommandFacade[K]): void;
    reset(): void;
}
export declare function createCapabilityGatedWorkbenchCommandFacade(delegate: WorkbenchCommandFacade, capabilities: WorkbenchCommandCapabilities): WorkbenchCommandFacade;
export declare function createFakeWorkbenchCommandFacade(overrides?: Partial<WorkbenchCommandFacade>): FakeWorkbenchCommandFacade;
