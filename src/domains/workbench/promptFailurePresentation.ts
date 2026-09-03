/**
 * Display-only prompt failure copy.
 *
 * The ACP error string is retained as a technical detail, but it is not a
 * trustworthy source for a user-facing duration: providers may include their
 * configured timeout (for example "180s") even when they return immediately.
 * Keep this helper pure so the legacy controller and the Workbench normalizer
 * apply the same rule without sharing stores or renderer code.
 */

export interface PromptFailurePresentationMetadata {
  readonly source?: string
  readonly timeoutKind?: string
  readonly configuredTimeoutSecs?: number
  readonly triggeredTimeoutSecs?: number
  readonly actualElapsedMs?: number
  readonly providerMessage?: string
}

export interface PromptFailurePresentation {
  readonly userSummary: string
  readonly technicalMessage?: string
}

function cleanText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function finitePositive(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

function seconds(value: unknown): string | undefined {
  const number = finitePositive(value)
  if (number === undefined) return undefined
  const rounded = Number.isInteger(number) ? String(number) : number.toFixed(1).replace(/\.0$/, '')
  return `${rounded}s`
}

function timeoutCopy(kind: string | undefined, bound: string | undefined): string {
  const suffix = bound ? `（${bound}）` : ''
  switch (kind) {
    case 'first-token': return `首个响应超时${suffix}`
    case 'idle': return `响应闲置超时${suffix}`
    case 'rpc': return `RPC 请求超时${suffix}`
    case 'write': return `ACP 写入超时${suffix}`
    default: return `请求超时${suffix}`
  }
}

function timeoutBound(failure: PromptFailurePresentationMetadata | undefined): string | undefined {
  // An explicitly supplied (but malformed) triggered bound must not silently
  // fall back to the configured budget and recreate the original false 180s
  // claim.  Only an absent triggered value may use configuredTimeoutSecs.
  return failure?.triggeredTimeoutSecs !== undefined
    ? seconds(failure.triggeredTimeoutSecs)
    : seconds(failure?.configuredTimeoutSecs)
}

function inferProviderFailure(raw: string, failure: PromptFailurePresentationMetadata | undefined): boolean {
  if (failure?.source === 'provider') return true
  // Older ACP providers emitted only a free-form error string.  Their
  // configured timeout (for example "180s") is provider metadata, not proof
  // that the local prompt actually waited that long.  Treat the stable
  // protocol/provider wording as a provider failure and keep the raw string
  // in technical details.
  return /(?:^|\b)ACP\s+protocol\s*:/i.test(raw) && /provider\s+error/i.test(raw)
}

/** Resolve safe user copy while preserving the provider/local error detail. */
export function presentPromptFailure(
  error: unknown,
  failure?: PromptFailurePresentationMetadata,
): PromptFailurePresentation {
  const raw = cleanText(error) ?? cleanText(failure?.providerMessage) ?? '未知错误'
  const source = cleanText(failure?.source)
  let userSummary: string
  switch (inferProviderFailure(raw, failure) ? 'provider' : source) {
    case 'provider':
      userSummary = 'Provider 返回错误'
      break
    case 'prompt-timeout':
      userSummary = timeoutCopy(
        cleanText(failure?.timeoutKind),
        timeoutBound(failure),
      )
      break
    case 'rpc':
      userSummary = timeoutCopy('rpc', timeoutBound(failure))
      break
    case 'write-timeout':
      userSummary = timeoutCopy('write', timeoutBound(failure))
      break
    case 'connection':
      userSummary = 'ACP 连接已关闭'
      break
    case 'cancelled':
      userSummary = '请求已取消'
      break
    case 'internal':
      userSummary = '处理失败'
      break
    default:
      userSummary = raw
      break
  }
  const technicalMessage = cleanText(failure?.providerMessage) ?? raw
  return technicalMessage === userSummary
    ? { userSummary }
    : { userSummary, technicalMessage }
}
