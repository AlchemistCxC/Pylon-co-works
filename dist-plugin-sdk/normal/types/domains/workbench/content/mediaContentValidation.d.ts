export type MediaContentKind = 'image' | 'audio' | 'video';
export type MediaSourceKind = 'url' | 'path' | 'base64' | 'blob';
/** Canonical inline-media limit. The payload is stored once in ContentPart.source. */
export declare const MAX_INLINE_MEDIA_SOURCE_BYTES: number;
export declare function isMediaContentKind(value: unknown): value is MediaContentKind;
export declare function isMediaSourceKind(value: unknown): value is MediaSourceKind;
export declare function isValidMediaMime(kind: MediaContentKind, value: unknown): boolean;
export declare function isValidMediaDimension(value: unknown): boolean;
export declare function isValidMediaDuration(value: unknown): boolean;
export declare function hasForbiddenMediaSideChannel(value: Record<string, unknown>): boolean;
export declare function isValidMediaSource(source: unknown, sourceKind: unknown, mimeType: unknown, contentKind: MediaContentKind): boolean;
export declare function isValidMediaContentInput(input: unknown, expectedKind?: MediaContentKind): boolean;
