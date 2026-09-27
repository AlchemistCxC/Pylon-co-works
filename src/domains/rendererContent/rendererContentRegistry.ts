/** 产品查询门面；数据唯一来自统一 Renderer Registry。 */
import type { CodeHighlightProvider, SpinnerProvider } from '../../contracts/rendererContentPoints.ts'
import { getRendererRegistry } from '../../plugin-runtime/runtimeServices.ts'

export function resolveCodeHighlightProvider(language = '', code = ''): CodeHighlightProvider | undefined {
  const entry = getRendererRegistry().resolveCodeHighlighter({ language, code })
  return entry ? { providerId: entry.value.id, highlight: entry.value.highlight } : undefined
}

export function resolveSpinnerProvider(input?: unknown): SpinnerProvider | undefined {
  return getRendererRegistry().resolveContentRenderer({ kind: 'spinner', payload: input })?.value.provider as SpinnerProvider | undefined
}
