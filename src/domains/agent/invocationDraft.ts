export interface InvocationDraft {
  executable: string
  args: string[]
}

export type InvocationIssueSeverity = 'error' | 'warning'

export interface InvocationIssue {
  severity: InvocationIssueSeverity
  code: 'executable_empty' | 'executable_nul' | 'argument_nul' | 'argument_empty' | 'argument_too_long'
  message: string
  argumentIndex?: number
}

export interface InvocationValidation {
  ok: boolean
  issues: InvocationIssue[]
}

export interface EffectiveInvocation {
  executable: string
  editableArgs: readonly string[]
  effectiveArgs: readonly string[]
  display: string
  validation: InvocationValidation
}

const ARGUMENT_WARNING_LENGTH = 4096

export function appendArgument(args: readonly string[], value = ''): string[] {
  return [...args, value]
}

export function updateArgument(args: readonly string[], index: number, value: string): string[] {
  if (index < 0 || index >= args.length) return [...args]
  return args.map((argument, currentIndex) => currentIndex === index ? value : argument)
}

export function removeArgument(args: readonly string[], index: number): string[] {
  if (index < 0 || index >= args.length) return [...args]
  return args.filter((_, currentIndex) => currentIndex !== index)
}

export function moveArgument(args: readonly string[], fromIndex: number, toIndex: number): string[] {
  if (fromIndex < 0 || fromIndex >= args.length || toIndex < 0 || toIndex >= args.length || fromIndex === toIndex) {
    return [...args]
  }
  const next = [...args]
  const [argument] = next.splice(fromIndex, 1)
  next.splice(toIndex, 0, argument)
  return next
}

function quoteWindowsArgument(value: string): string {
  if (value.length > 0 && !/[\s"]/.test(value)) return value

  let quoted = '"'
  let backslashes = 0
  for (const character of value) {
    if (character === '\\') {
      backslashes += 1
      continue
    }
    if (character === '"') {
      quoted += '\\'.repeat(backslashes * 2 + 1)
      quoted += '"'
      backslashes = 0
      continue
    }
    quoted += '\\'.repeat(backslashes)
    quoted += character
    backslashes = 0
  }
  quoted += '\\'.repeat(backslashes * 2)
  return `${quoted}"`
}

export function formatInvocationForDisplay(executable: string, args: readonly string[]): string {
  return [executable, ...args].map(quoteWindowsArgument).join(' ')
}

export function validateInvocation(draft: InvocationDraft): InvocationValidation {
  const issues: InvocationIssue[] = []
  if (!draft.executable.trim()) {
    issues.push({ severity: 'error', code: 'executable_empty', message: '可执行文件不能为空' })
  } else if (draft.executable.includes('\0')) {
    issues.push({ severity: 'error', code: 'executable_nul', message: '可执行文件不能包含 NUL 字符' })
  }

  draft.args.forEach((argument, argumentIndex) => {
    if (argument.length === 0) {
      issues.push({ severity: 'warning', code: 'argument_empty', message: `参数 ${argumentIndex + 1} 是合法空字符串`, argumentIndex })
    }
    if (argument.includes('\0')) {
      issues.push({ severity: 'error', code: 'argument_nul', message: `参数 ${argumentIndex + 1} 不能包含 NUL 字符`, argumentIndex })
    }
    if (argument.length > ARGUMENT_WARNING_LENGTH) {
      issues.push({ severity: 'warning', code: 'argument_too_long', message: `参数 ${argumentIndex + 1} 超过 ${ARGUMENT_WARNING_LENGTH} 个字符`, argumentIndex })
    }
  })

  return { ok: !issues.some(issue => issue.severity === 'error'), issues }
}

export function describeInvocation(
  draft: InvocationDraft,
  effectiveArgs: readonly string[] = draft.args,
): EffectiveInvocation {
  return {
    executable: draft.executable,
    editableArgs: [...draft.args],
    effectiveArgs: [...effectiveArgs],
    display: formatInvocationForDisplay(draft.executable, effectiveArgs),
    validation: validateInvocation(draft),
  }
}
