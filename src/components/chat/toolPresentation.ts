export interface ToolPresentation {
  getSummary(input: unknown): string
  getSearchText?(output: unknown): string
  normalizeInput?(input: unknown): unknown
}

const firstString = (...values: unknown[]): string =>
  values.find((value): value is string => typeof value === 'string' && value.length > 0) || ''

function objectInput(input: unknown): Record<string, unknown> {
  return typeof input === 'object' && input !== null ? input as Record<string, unknown> : {}
}

function fieldSummary(...fields: string[]) {
  return (input: unknown) => firstString(...fields.map(field => objectInput(input)[field]))
}

const TOOL_PRESENTATIONS: Record<string, ToolPresentation> = {
  Bash: { getSummary: fieldSummary('command', 'cmd') },
  Read: { getSummary: fieldSummary('path', 'file_path', 'filePath') },
  Write: { getSummary: fieldSummary('path', 'file_path', 'filePath') },
  Edit: { getSummary: fieldSummary('path', 'file_path', 'filePath') },
  Grep: { getSummary: fieldSummary('pattern', 'regex', 'glob') },
  Glob: { getSummary: fieldSummary('pattern', 'regex', 'glob') },
  Task: { getSummary: fieldSummary('description', 'prompt', 'goal') },
}

const FALLBACK_PRESENTATION: ToolPresentation = {
  getSummary: input => {
    for (const value of Object.values(objectInput(input))) {
      if (typeof value === 'string' && value.length > 0 && value.length < 200) return value
    }
    return typeof input === 'string' ? input.slice(0, 80) : ''
  },
}

export function resolveToolPresentation(toolName: string): ToolPresentation {
  return TOOL_PRESENTATIONS[toolName] || FALLBACK_PRESENTATION
}

export function getToolSummary(toolName: string, input: unknown): string {
  return resolveToolPresentation(toolName).getSummary(input)
}
