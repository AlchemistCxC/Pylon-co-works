export interface RenderResourceRange {
  readonly start: {
    readonly line: number
    readonly character?: number
  }
}

export type RenderResourceTarget =
  | { readonly path: string; readonly range?: RenderResourceRange }
  | { readonly uri: string; readonly range?: RenderResourceRange }

const URI_CARRIER = /(?:^|_)(?:uri|url|href|resource_uri)$/i

export function classifyResourceTarget(
  value: string,
  carrier?: string,
  range?: RenderResourceRange,
): RenderResourceTarget {
  const trimmed = value.trim()
  const normalizedCarrier = carrier?.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`)
  const target = normalizedCarrier && URI_CARRIER.test(normalizedCarrier)
    ? { uri: trimmed }
    : isUriLike(trimmed)
      ? { uri: trimmed }
      : { path: trimmed }
  return range ? { ...target, range } : target
}

export function resourceRange(line?: number, column?: number): RenderResourceRange | undefined {
  return line === undefined
    ? undefined
    : { start: { line, ...(column !== undefined ? { character: column } : {}) } }
}

export function isUriLike(value: string): boolean {
  return !/^[a-z]:[\\/]/i.test(value) && /^[a-z][a-z\d+.-]*:/i.test(value)
}
