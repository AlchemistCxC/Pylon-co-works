/** 产品查询门面；数据唯一来自统一 Renderer Registry。 */
import type {
  AnsiProvider,
  CodeHighlightProvider,
  FooterProvider,
  PlanProvider,
  SpinnerProvider,
} from '../../contracts/rendererContentPoints.ts'
import { getRendererRegistry } from '../../plugin-runtime/runtimeServices.ts'

export function listCodeHighlightProviders(): CodeHighlightProvider[] {
  return getRendererRegistry().snapshot().codeHighlighters.map(entry => ({
    providerId: entry.value.id,
    highlight: entry.value.highlight,
  }))
}

export function resolveCodeHighlightProvider(language = '', code = ''): CodeHighlightProvider | undefined {
  const entry = getRendererRegistry().resolveCodeHighlighter({ language, code })
  return entry ? { providerId: entry.value.id, highlight: entry.value.highlight } : undefined
}

export function listAnsiProviders(): AnsiProvider[] {
  return getRendererRegistry().snapshot().contentRenderers
    .filter(entry => entry.value.kind === 'ansi')
    .map(entry => entry.value.provider as AnsiProvider)
}

export function resolveAnsiProvider(text = ''): AnsiProvider | undefined {
  return getRendererRegistry().resolveContentRenderer({ kind: 'ansi', payload: text })?.value.provider as AnsiProvider | undefined
}

export function listSpinnerProviders(): SpinnerProvider[] {
  return getRendererRegistry().snapshot().contentRenderers
    .filter(entry => entry.value.kind === 'spinner')
    .map(entry => entry.value.provider as SpinnerProvider)
}

export function resolveSpinnerProvider(input?: unknown): SpinnerProvider | undefined {
  return getRendererRegistry().resolveContentRenderer({ kind: 'spinner', payload: input })?.value.provider as SpinnerProvider | undefined
}

export function listPlanProviders(): PlanProvider[] {
  return getRendererRegistry().snapshot().contentRenderers
    .filter(entry => entry.value.kind === 'plan')
    .map(entry => entry.value.provider as PlanProvider)
}

export function listFooterProviders(): FooterProvider[] {
  return getRendererRegistry().snapshot().contentRenderers
    .filter(entry => entry.value.kind === 'footer')
    .map(entry => entry.value.provider as FooterProvider)
}
