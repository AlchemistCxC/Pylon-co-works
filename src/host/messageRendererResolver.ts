import type { MessageRenderer } from '../contracts/messageRenderer.ts'
import { getRendererRegistry } from '../plugin-runtime/runtimeServices.ts'
import type { MessageRendererInput } from '../plugin-runtime/renderers/rendererTypes.ts'

export function subscribeMessageRenderers(listener: () => void): () => void {
  return getRendererRegistry().subscribe(listener)
}

export function getMessageRendererSnapshot() {
  return getRendererRegistry().snapshot()
}

export function resolveActiveMessageRenderers(): MessageRenderer[] {
  return getRendererRegistry().snapshot().messageRenderers.map(entry => entry.value.renderer)
}

export function resolveMessageRendererIds(): string[] {
  return resolveActiveMessageRenderers().map(renderer => renderer.rendererId)
}

export function resolveMessageRenderer(rendererId: string, input: Omit<MessageRendererInput, 'rendererId'> = {}): MessageRenderer | undefined {
  return getRendererRegistry().resolveMessageRenderer({ ...input, rendererId })?.value.renderer
}

export function resolveDefaultMessageRenderer(input: MessageRendererInput = {}): MessageRenderer | undefined {
  return getRendererRegistry().resolveMessageRenderer(input)?.value.renderer
}

export function resolveMessageRendererEntry(input: MessageRendererInput = {}) {
  return getRendererRegistry().resolveMessageRenderer(input)
}

export function resolveFallbackMessageRendererEntry(input: MessageRendererInput = {}, excludedContributionId?: string) {
  return getRendererRegistry().resolveFallbackMessageRenderer(input, excludedContributionId)
}
