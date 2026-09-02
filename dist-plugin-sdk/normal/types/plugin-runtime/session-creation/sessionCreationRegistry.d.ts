import type { PluginIdentity } from '../pluginIdentity.js';
import type { AsyncDisposable, RegistrySnapshot } from '../registry/types.js';
import type { SessionCreationArtifactHandler, SessionCreationCompiler, SessionCreationContribution } from './sessionCreationTypes.js';
export declare function validateSessionCreationContribution(contribution: SessionCreationContribution): SessionCreationContribution;
export declare function validateSessionCreationCompiler(compiler: SessionCreationCompiler): SessionCreationCompiler;
export declare function validateSessionCreationArtifactHandler(handler: SessionCreationArtifactHandler): SessionCreationArtifactHandler;
export interface SessionCreationRegistrySnapshot {
    readonly revision: number;
    readonly contributions: RegistrySnapshot<SessionCreationContribution>;
    readonly compilers: RegistrySnapshot<SessionCreationCompiler>;
    readonly handlers: RegistrySnapshot<SessionCreationArtifactHandler>;
}
export interface SessionCreationRegistryTransaction {
    readonly owner: PluginIdentity;
    registerContribution(contribution: SessionCreationContribution): AsyncDisposable;
    registerCompiler(compiler: SessionCreationCompiler): AsyncDisposable;
    registerArtifactHandler(handler: SessionCreationArtifactHandler): AsyncDisposable;
    validate(): void;
    commit(): readonly AsyncDisposable[];
    rollback(): void;
    revert(): void;
}
export declare class SessionCreationRegistry {
    private readonly contributions;
    private readonly compilers;
    private readonly handlers;
    registerContribution(owner: PluginIdentity, contribution: SessionCreationContribution): AsyncDisposable;
    registerCompiler(owner: PluginIdentity, compiler: SessionCreationCompiler): AsyncDisposable;
    registerArtifactHandler(owner: PluginIdentity, handler: SessionCreationArtifactHandler): AsyncDisposable;
    beginShadowTransaction(owner: PluginIdentity, replacingRuntimeInstanceId: string): SessionCreationRegistryTransaction;
    subscribe(listener: () => void): () => void;
    getSnapshot(): SessionCreationRegistrySnapshot;
}
