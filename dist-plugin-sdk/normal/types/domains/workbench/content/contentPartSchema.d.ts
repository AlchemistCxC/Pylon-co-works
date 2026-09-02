/**
 * Framework-free semantic content contract.
 *
 * Content parts are deliberately independent from Message/React/Solid.  A
 * provider may introduce a namespaced kind, but an unrecognised kind is still
 * represented as `unknown` so the projector can show evidence instead of
 * silently dropping it.
 */
import { type MediaSourceKind } from './mediaContentValidation.js';
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | {
    readonly [key: string]: JsonValue;
};
export type ContentKind = 'text' | 'markdown' | 'code' | 'ansi' | 'reasoning' | 'thinking' | 'redacted-reasoning' | 'image' | 'audio' | 'video' | 'document' | 'resource' | 'file-reference' | 'file-selection' | 'diff' | 'location' | 'terminal' | 'log' | 'progress' | 'list' | 'key-value' | 'json' | 'link' | 'search-result' | 'diagnostic-lsp' | 'tool-use' | 'tool-result' | 'artifact' | 'unknown' | `${string}.${string}`;
export interface ContentTruncation {
    readonly truncated: boolean;
    readonly originalBytes: number;
    readonly retainedBytes: number;
    readonly omittedBytes: number;
    readonly reason: 'size-limit' | 'non-serializable' | 'sensitive';
}
export interface SchemaIssue {
    readonly path: readonly (string | number)[];
    readonly code: string;
    readonly expected: string;
    readonly received: string;
    readonly summary: string;
}
export type SchemaResult<T> = {
    readonly ok: true;
    readonly value: T;
} | {
    readonly ok: false;
    readonly issues: readonly SchemaIssue[];
};
export interface UnknownContentPart {
    readonly kind: 'unknown';
    readonly originalType: string;
    readonly summary: string;
    readonly raw: JsonValue;
    readonly truncated: boolean;
    readonly truncation?: ContentTruncation;
    readonly redactions?: readonly {
        readonly path: readonly (string | number)[];
        readonly reason: 'sensitive';
    }[];
}
export interface TextContentPart {
    readonly kind: 'text' | 'markdown' | 'code' | 'ansi' | 'reasoning' | 'thinking';
    readonly text: string;
    readonly language?: string;
}
export interface ImageContentPart {
    readonly kind: 'image' | 'audio' | 'video';
    readonly source: string;
    readonly sourceKind?: MediaSourceKind;
    readonly mimeType?: string;
    readonly alt?: string;
    readonly caption?: string;
    readonly width?: number;
    readonly height?: number;
    readonly durationMs?: number;
    readonly poster?: string;
    readonly transcript?: string;
}
export type MediaContentPart = ImageContentPart;
export interface ResourceContentPart {
    readonly kind: 'resource';
    readonly uri: string;
    readonly title?: string;
    readonly mimeType?: string;
    readonly text?: string;
    /** Binary presence marker only; raw base64 is excluded from canonical display content. */
    readonly hasBlob?: boolean;
}
export interface DocumentContentPart {
    readonly kind: 'document';
    readonly title?: string;
    readonly path?: string;
    readonly uri?: string;
    readonly mimeType?: string;
    readonly text?: string;
    /** Binary presence marker only; raw base64 is excluded from canonical display content. */
    readonly hasBlob?: boolean;
}
export interface SearchHighlightRange {
    readonly start: number;
    readonly end: number;
}
export interface SearchResultLocation {
    readonly path?: string;
    readonly uri?: string;
    readonly line?: number;
    readonly column?: number;
    readonly endLine?: number;
    readonly endColumn?: number;
}
export interface SearchResultEntry {
    readonly source: string;
    readonly rank?: number;
    readonly title?: string;
    readonly location?: SearchResultLocation;
    readonly snippet?: string;
    readonly highlights?: readonly SearchHighlightRange[];
    readonly score?: number;
    readonly pagingToken?: string;
}
export interface SearchResultContentPart {
    readonly kind: 'search-result';
    readonly query?: string;
    readonly total?: number;
    readonly pagingToken?: string;
    readonly results: readonly SearchResultEntry[];
}
export interface LinkContentPart {
    readonly kind: 'link';
    readonly url: string;
    readonly title?: string;
    readonly status?: number;
}
export interface TextPosition {
    readonly line: number;
    readonly character?: number;
}
export interface TextRange {
    readonly start: TextPosition;
    readonly end?: TextPosition;
}
export interface DiffContentLine {
    readonly kind: 'context' | 'added' | 'removed';
    readonly text: string;
}
export interface DiffContentHunk {
    readonly oldStart?: number;
    readonly oldLines?: number;
    readonly newStart?: number;
    readonly newLines?: number;
}
export interface DiffContentPart {
    readonly kind: 'diff';
    readonly path?: string;
    readonly oldPath?: string;
    readonly status?: string;
    readonly range?: TextRange;
    readonly hunks?: readonly DiffContentHunk[];
    readonly lines?: readonly DiffContentLine[];
    readonly oldText?: string;
    readonly newText?: string;
    readonly additions?: number;
    readonly deletions?: number;
    readonly binary?: boolean;
    readonly truncated?: boolean;
    readonly truncation?: ContentTruncation;
    readonly unified?: string;
    readonly rawPatch?: JsonValue;
    readonly unknownFields?: readonly string[];
}
export interface LspRelatedInformation {
    readonly message: string;
    readonly path: string;
    readonly range?: TextRange;
}
export interface LspDiagnosticContentPart {
    readonly kind: 'diagnostic-lsp';
    readonly severity?: string;
    readonly code?: string;
    readonly source?: string;
    readonly message: string;
    readonly path: string;
    readonly range?: TextRange;
    readonly related?: readonly LspRelatedInformation[];
    readonly unknownFields?: readonly string[];
}
export type TerminalStreamKind = 'stdout' | 'stderr';
export type TerminalStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
export type TerminalTermination = 'timeout' | 'killed' | 'signal';
export interface TerminalStreamEntry {
    readonly stream: TerminalStreamKind;
    readonly text: string;
    readonly ordinal?: number;
    readonly lateAfterTerminal?: boolean;
    readonly timestamp?: string;
    readonly timestampConfidence?: 'exact' | 'observed' | 'synthetic' | 'unknown';
}
export interface TerminalOutputTruncation {
    readonly capturedLines?: number;
    readonly omittedLines?: number;
    readonly capturedBytes?: number;
    readonly omittedBytes?: number;
}
export interface TerminalContentPart {
    readonly kind: 'terminal';
    readonly command?: string;
    readonly processId?: string;
    readonly sessionId?: string;
    readonly streams: readonly TerminalStreamEntry[];
    readonly status?: TerminalStatus;
    readonly exitCode?: number;
    readonly terminatedBy?: TerminalTermination;
    readonly durationMs?: number;
    readonly env?: Readonly<Record<string, string>>;
    readonly truncation?: TerminalOutputTruncation;
    readonly error?: {
        readonly message: string;
        readonly code?: string;
    };
}
export interface LogContentEntry {
    readonly level: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal' | 'unknown';
    readonly originalLevel?: string;
    readonly text: string;
    readonly ordinal?: number;
    readonly timestamp?: string;
    readonly timestampConfidence?: 'exact' | 'observed' | 'synthetic' | 'unknown';
}
export interface LogContentPart {
    readonly kind: 'log';
    readonly source?: string;
    readonly processId?: string;
    readonly sessionId?: string;
    readonly entries: readonly LogContentEntry[];
    readonly truncation?: TerminalOutputTruncation;
}
export interface MemoryContentPart {
    readonly kind: 'memory';
    readonly memoryId: string;
    readonly title: string;
    readonly source: string;
    readonly scope?: string;
    readonly summary?: string;
    readonly status?: string;
    readonly version?: string | number;
    readonly enabled?: boolean;
    readonly used?: boolean;
    readonly raw?: Readonly<Record<string, JsonValue>>;
}
export interface SkillContentPart {
    readonly kind: 'skill';
    readonly skillId: string;
    readonly title: string;
    readonly source: string;
    readonly scope?: string;
    readonly summary?: string;
    readonly status?: string;
    readonly version?: string | number;
    readonly enabled?: boolean;
    readonly used?: boolean;
    readonly uri?: string;
    readonly raw?: Readonly<Record<string, JsonValue>>;
}
export interface McpResourceContentPart {
    readonly kind: 'mcp-resource';
    readonly server: string;
    readonly resourceUri: string;
    readonly tool?: string;
    readonly title?: string;
    readonly mimeType?: string;
    readonly summary?: string;
    readonly connectionState?: string;
    readonly status?: string;
    readonly raw?: Readonly<Record<string, JsonValue>>;
}
export interface ArtifactContentPart {
    readonly kind: 'artifact';
    readonly artifactId: string;
    readonly title: string;
    readonly uri: string;
    readonly version?: string | number;
    readonly mimeType?: string;
    readonly summary?: string;
    readonly status?: string;
    readonly hasBlob?: boolean;
    readonly parts?: readonly ContentPart[];
    readonly actions?: readonly string[];
    readonly raw?: Readonly<Record<string, JsonValue>>;
}
export interface HookSurfaceSnapshot {
    readonly phase: string;
    readonly owner: Readonly<{
        pluginId: string;
        runtimeInstanceId?: string;
        handlerId: string;
    }>;
    readonly status: string;
    readonly durationMs?: number;
    readonly decision?: string;
    readonly error?: Readonly<{
        message: string;
        code?: string;
    }>;
    readonly raw?: Readonly<Record<string, JsonValue>>;
}
export type ContentPart = TextContentPart | ImageContentPart | ResourceContentPart | DocumentContentPart | SearchResultContentPart | LinkContentPart | DiffContentPart | LspDiagnosticContentPart | TerminalContentPart | LogContentPart | MemoryContentPart | SkillContentPart | McpResourceContentPart | ArtifactContentPart | UnknownContentPart | {
    readonly kind: Exclude<ContentKind, TextContentPart['kind'] | ImageContentPart['kind'] | ResourceContentPart['kind'] | DocumentContentPart['kind'] | SearchResultContentPart['kind'] | LinkContentPart['kind'] | DiffContentPart['kind'] | LspDiagnosticContentPart['kind'] | TerminalContentPart['kind'] | LogContentPart['kind'] | MemoryContentPart['kind'] | SkillContentPart['kind'] | McpResourceContentPart['kind'] | ArtifactContentPart['kind'] | 'unknown'>;
    readonly [key: string]: unknown;
};
/**
 * Streaming transports commonly emit one text part per delta. Those are wire
 * fragments, not semantic block boundaries: parsing each fragment as its own
 * Markdown document produces one paragraph per token. Preserve rich-content
 * boundaries while folding adjacent display-text fragments into one part.
 */
export declare function coalesceAdjacentDisplayTextParts(parts: readonly ContentPart[]): readonly ContentPart[];
/**
 * Reasoning deltas are wire fragments, not paragraph boundaries.  Unlike the
 * general display-text helper this also accepts the protocol's `reasoning`
 * and `thinking` text kinds, while deliberately keeping code/ANSI, media,
 * tool and other rich parts as hard boundaries.
 */
export declare function coalesceAdjacentReasoningParts(parts: readonly ContentPart[]): readonly ContentPart[];
export interface UnknownContentOptions {
    readonly maxRawBytes?: number;
}
export declare function createUnknownContentPart(originalType: string, raw: unknown, options?: UnknownContentOptions): UnknownContentPart;
export declare function parseContentPart(value: unknown): SchemaResult<ContentPart>;
export declare function isValidSearchResultContentInput(input: unknown): input is Omit<SearchResultContentPart, 'kind'> | SearchResultContentPart;
export declare function isValidLinkContentInput(input: unknown): input is Omit<LinkContentPart, 'kind'> | LinkContentPart;
export declare function isValidMemoryContentInput(input: unknown): input is MemoryContentPart;
export declare function isValidSkillContentInput(input: unknown): input is SkillContentPart;
export declare function isValidMcpResourceContentInput(input: unknown): input is McpResourceContentPart;
export declare function isValidArtifactContentInput(input: unknown): input is ArtifactContentPart;
export declare function isValidHookSurfaceInput(input: unknown): input is HookSurfaceSnapshot;
export declare function isValidDiffContentInput(input: unknown): input is Omit<DiffContentPart, 'kind'> | DiffContentPart;
export declare function isValidLspDiagnosticContentInput(input: unknown): input is Omit<LspDiagnosticContentPart, 'kind'> | LspDiagnosticContentPart;
export declare function isValidTerminalContentInput(input: unknown): input is Omit<TerminalContentPart, 'kind'> | TerminalContentPart;
export declare function isValidLogContentInput(input: unknown): input is Omit<LogContentPart, 'kind'> | LogContentPart;
export declare const MAX_ARTIFACT_PREVIEW_PARTS = 256;
export declare function isJsonValue(value: unknown): value is JsonValue;
