export interface FileSelectionRange {
  readonly start?: { readonly line?: number; readonly column?: number }
  readonly end?: { readonly line?: number; readonly column?: number }
}

export function formatFileSelectionRange(selection: FileSelectionRange | undefined): string | undefined {
  if (!selection) return undefined
  const start = selection.start?.line !== undefined ? `L${selection.start.line}${selection.start.column !== undefined ? `:${selection.start.column}` : ''}` : undefined
  const end = selection.end?.line !== undefined ? `L${selection.end.line}` : undefined
  if (start && end && start !== end) return `${start}–${end}`
  return start ?? end
}

export function fileContentLastSegment(value: string): string {
  const segments = value.replace(/\\/g, '/').split('/').filter(Boolean)
  return segments.at(-1) || value
}

export function isBinaryFileContent(value: { readonly mimeType?: string; readonly hasBlob?: boolean }): boolean {
  return value.hasBlob === true || (value.mimeType?.startsWith('application/') ?? false)
}

export function presentFileContentPath(
  path: string,
  options: { readonly showAbsolutePath?: boolean; readonly pathCollapse?: 'full' | 'middle' | 'basename' } = {},
): string | undefined {
  if (options.showAbsolutePath === false) return undefined
  switch (options.pathCollapse) {
    case 'basename': return fileContentLastSegment(path)
    case 'full': return path
    default: return path.length > 64 ? `${path.slice(0, 28)}…${path.slice(-32)}` : path
  }
}

export function previewFileContentText(text: string, requestedLines: number | undefined, fallbackLines = 12): string {
  const finite = typeof requestedLines === 'number' && Number.isFinite(requestedLines) ? requestedLines : fallbackLines
  const lines = Math.max(1, Math.min(200, Math.floor(finite)))
  return text.split('\n').slice(0, lines).join('\n')
}
