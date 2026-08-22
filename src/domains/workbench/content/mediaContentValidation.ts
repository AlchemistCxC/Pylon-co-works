export type MediaContentKind = 'image' | 'audio' | 'video'
export type MediaSourceKind = 'url' | 'path' | 'base64' | 'blob'

/** Canonical inline-media limit. The payload is stored once in ContentPart.source. */
export const MAX_INLINE_MEDIA_SOURCE_BYTES = 8 * 1024 * 1024

const BASE64_ALPHABET = /^[A-Za-z0-9+/]+={0,2}$/
const REMOTE_URL = /^https?:\/\//i
const BLOB_URL = /^blob:/i
const DATA_URL = /^data:([^;,]+);base64,([A-Za-z0-9+/]+={0,2})$/i
const URI_SCHEME = /^[a-z][a-z\d+.-]*:/i
const WINDOWS_DRIVE_PATH = /^[a-z]:[\\/]/i

export function isMediaContentKind(value: unknown): value is MediaContentKind {
  return value === 'image' || value === 'audio' || value === 'video'
}

export function isMediaSourceKind(value: unknown): value is MediaSourceKind {
  return value === 'url' || value === 'path' || value === 'base64' || value === 'blob'
}

export function isValidMediaMime(kind: MediaContentKind, value: unknown): boolean {
  return value === undefined || (typeof value === 'string' && value.toLowerCase().startsWith(`${kind}/`))
}

export function isValidMediaDimension(value: unknown): boolean {
  return value === undefined || (typeof value === 'number' && Number.isFinite(value) && value > 0)
}

export function isValidMediaDuration(value: unknown): boolean {
  return value === undefined || (typeof value === 'number' && Number.isFinite(value) && value >= 0)
}

export function hasForbiddenMediaSideChannel(value: Record<string, unknown>): boolean {
  return ['url', 'localPath', 'base64', 'blob', 'headers', 'requestHeaders', 'authorization', 'token', 'secret']
    .some(key => value[key] !== undefined)
}

export function isValidMediaSource(
  source: unknown,
  sourceKind: unknown,
  mimeType: unknown,
  contentKind: MediaContentKind,
): boolean {
  if (typeof source !== 'string' || !source.trim()) return false
  const trimmed = source.trim()

  // Older standard ACP fixtures only carried source. They remain valid for
  // already-safe URL forms; path/base64 need an explicit canonical kind.
  if (sourceKind === undefined) return isSafeLegacyMediaUrl(trimmed, contentKind)
  if (!isMediaSourceKind(sourceKind)) return false
  if (sourceKind === 'url') return REMOTE_URL.test(trimmed)
  if (sourceKind === 'blob') return BLOB_URL.test(trimmed)
  if (sourceKind === 'path') {
    if (WINDOWS_DRIVE_PATH.test(trimmed)) return true
    return !URI_SCHEME.test(trimmed)
  }

  const data = DATA_URL.exec(trimmed)
  if (data) {
    return data[1]!.toLowerCase().startsWith(`${contentKind}/`)
      && data[2]!.length <= MAX_INLINE_MEDIA_SOURCE_BYTES
      && isPaddedBase64(data[2]!)
  }
  return typeof mimeType === 'string'
    && mimeType.toLowerCase().startsWith(`${contentKind}/`)
    && trimmed.length <= MAX_INLINE_MEDIA_SOURCE_BYTES
    && isPaddedBase64(trimmed)
}

export function isValidMediaContentInput(input: unknown, expectedKind?: MediaContentKind): boolean {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false
  const value = input as Record<string, unknown>
  const kind = expectedKind ?? value.kind
  if (!isMediaContentKind(kind)) return false
  return isValidMediaSource(value.source, value.sourceKind, value.mimeType, kind)
    && isValidMediaMime(kind, value.mimeType)
    && isValidMediaDimension(value.width)
    && isValidMediaDimension(value.height)
    && isValidMediaDuration(value.durationMs)
    && ['alt', 'caption', 'poster', 'transcript'].every(key => value[key] === undefined || typeof value[key] === 'string')
    && !hasForbiddenMediaSideChannel(value)
}

function isSafeLegacyMediaUrl(source: string, contentKind: MediaContentKind): boolean {
  if (REMOTE_URL.test(source) || BLOB_URL.test(source)) return true
  const data = DATA_URL.exec(source)
  return Boolean(data
    && data[1]!.toLowerCase().startsWith(`${contentKind}/`)
    && data[2]!.length <= MAX_INLINE_MEDIA_SOURCE_BYTES
    && isPaddedBase64(data[2]!))
}

function isPaddedBase64(value: string): boolean {
  return value.length > 0 && value.length % 4 === 0 && BASE64_ALPHABET.test(value)
}
