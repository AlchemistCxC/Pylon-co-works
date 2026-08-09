/**
 * Source-bound async request guard.
 *
 * A request is valid only while its source and generation still match the
 * component's current request context. Incrementing the generation on source
 * changes and disposal makes late responses harmless.
 */
export interface SourceRequestContext {
  source: string | null
  generation: number
}

export interface SourceRequestToken {
  source: string
  generation: number
}

export function advanceSourceContext(context: SourceRequestContext, source: string | null): SourceRequestContext {
  return { source, generation: context.generation + 1 }
}

export function beginSourceRequest(context: SourceRequestContext, source: string): SourceRequestToken {
  return { source, generation: context.generation }
}

export function isCurrentSourceRequest(context: SourceRequestContext, token: SourceRequestToken): boolean {
  return context.source === token.source && context.generation === token.generation
}
