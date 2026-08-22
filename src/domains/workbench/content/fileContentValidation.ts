export function isNonEmptyContentLocation(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

export function isOptionalNonNegativeFiniteNumber(value: unknown): boolean {
  return value === undefined || (typeof value === 'number' && Number.isFinite(value) && value >= 0)
}

export function isValidFileSelection(value: unknown): boolean {
  if (!isRecord(value)) return false
  const start = isRecord(value.start) ? value.start : undefined
  const end = isRecord(value.end) ? value.end : undefined
  const hasStart = isValidPosition(start)
  const hasEnd = isValidPosition(end)
  if (!hasStart && !hasEnd) return false
  if (!hasStart || !hasEnd) return true
  const startLine = Number(start!.line)
  const endLine = Number(end!.line)
  if (endLine < startLine) return false
  if (endLine === startLine && start!.column !== undefined && end!.column !== undefined) {
    return Number(end!.column) >= Number(start!.column)
  }
  return true
}

function isValidPosition(position: Record<string, unknown> | undefined): boolean {
  return Boolean(position
    && Number.isInteger(position.line)
    && Number(position.line) >= 0
    && (position.column === undefined || (Number.isInteger(position.column) && Number(position.column) >= 0)))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
