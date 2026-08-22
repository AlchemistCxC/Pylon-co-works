import type { RendererActivationSnapshot } from '../../plugin-runtime/renderers/rendererSuiteTypes.ts'

export interface RendererSuiteFallbackOptions {
  readonly current?: RendererActivationSnapshot
  readonly explicitFallback?: RendererActivationSnapshot
  readonly builtInSolid?: RendererActivationSnapshot
  readonly reactFatal?: RendererActivationSnapshot
}

/** Suite-level fallback only; never resolves individual kinds across Suites. */
export function resolveRendererSuiteFallback(options: RendererSuiteFallbackOptions): RendererActivationSnapshot | undefined {
  const currentFallback = options.current?.suite.value.fallbackSuiteId
  if (currentFallback && options.explicitFallback?.suite.value.id === currentFallback) return options.explicitFallback
  if (currentFallback && options.builtInSolid?.suite.value.id === currentFallback) return options.builtInSolid
  if (currentFallback && options.reactFatal?.suite.value.id === currentFallback) return options.reactFatal
  return options.builtInSolid ?? options.reactFatal
}
