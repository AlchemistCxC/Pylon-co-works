import type { SessionCreationRegistrySnapshot } from './sessionCreationRegistry.js';
import type { SessionCreationContext, SessionCreationJson, SessionCreationSnapshot } from './sessionCreationTypes.js';
export declare function normalizeSessionCreationJson(value: unknown, path?: string): SessionCreationJson;
export declare function compileSessionCreationSnapshot(registry: SessionCreationRegistrySnapshot, context: SessionCreationContext, now?: number): SessionCreationSnapshot;
export declare function normalizeSessionCreationSnapshot(value: unknown): SessionCreationSnapshot | undefined;
