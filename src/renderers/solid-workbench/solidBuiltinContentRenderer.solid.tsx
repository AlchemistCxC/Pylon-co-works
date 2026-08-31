import { For } from 'solid-js'
import { coalesceAdjacentDisplayTextParts, isValidDiffContentInput, isValidHookSurfaceInput, isValidLspDiagnosticContentInput, type ContentPart, type LspDiagnosticContentPart } from '../../domains/workbench/content/contentPartSchema.ts'
import { diffSnapshotFromPart } from '../../domains/workbench/diffSnapshot.ts'
import type { WorkbenchExtensionNode } from '../../domains/workbench/workbenchProjector.ts'
import type { RenderCommandPort } from '../../contracts/messageRenderer.ts'
import { canExecuteRendererSemanticCommand, executeRendererSemanticCommand } from '../../host/renderer-suite/rendererSemanticCommand.ts'
import { normalizeWorkbenchMountInput } from './workbenchContracts.ts'
import type { SolidWorkbenchContextValue } from './SolidWorkbenchContext.solid.tsx'
import { MarkdownContent } from './chat/MarkdownContent.solid.tsx'
import { SolidCodeBlock } from './chat/CodeBlock.solid.tsx'
import { SolidAnsiBlock } from './chat/AnsiBlock.solid.tsx'
import { SolidFileReferenceCard } from './chat/content/FileReference.solid.tsx'
import { SolidMediaBlock } from './chat/content/MediaBlock.solid.tsx'
import { BUILTIN_MEDIA_RESOLVER_OPTIONS } from './mediaAssetAdapter.ts'
import { SolidSearchOrLink } from './chat/content/SearchResults.solid.tsx'
import { SolidDiffContent, SolidLspDiagnosticContent } from './chat/content/DiffDiagnosticContent.solid.tsx'
import { SolidTerminalBlock, SolidLogBlock } from './chat/content/TerminalBlock.solid.tsx'
import { SolidExtensionContentCard } from './chat/content/ExtensionContentCard.solid.tsx'
import { SolidStructuredContent, isStructuredContentKind } from './chat/content/StructuredContent.solid.tsx'
import { SolidUnknownContent } from './chat/content/UnknownContent.solid.tsx'

export function fallbackRenderCommands(context: SolidWorkbenchContextValue): RenderCommandPort {
  const sessionId = context.input().sessionId
  const capabilities = context.hostPort?.capabilities
  return {
    canExecute: type => Boolean(sessionId && capabilities && canExecuteRendererSemanticCommand(type, capabilities)),
    execute: command => {
      const host = context.hostPort
      if (!host) return Promise.resolve()
      return executeRendererSemanticCommand({
        command,
        host,
        mountInput: normalizeWorkbenchMountInput(context.input()),
      })
    },
  }
}

export function sessionSurfaceAppearance(context: SolidWorkbenchContextValue, kind: string) {
  return context.hostPort?.appearance.resolve?.({
    kind,
    suiteId: context.activation?.suite.value.id ?? 'builtin.solid',
    slotId: 'builtin.solid.content.base',
  }) ?? { ...context.appearanceSnapshot(), reducedMotion: context.input().reducedMotion === true }
}

export function renderBuiltinContentPart(
  part: ContentPart,
  inline: boolean,
  context: SolidWorkbenchContextValue,
  streaming = false,
) {
  if (part.kind === 'text' || part.kind === 'markdown') {
    return <MarkdownContent text={part.text} inline={inline} streaming={streaming} />
  }
  if (part.kind === 'code') return <SolidCodeBlock code={part.text} language={part.language} />
  if (part.kind === 'ansi') return <SolidAnsiBlock text={part.text} reducedMotion={context.input().reducedMotion} />
  if (part.kind === 'file-reference' || part.kind === 'file-selection' || part.kind === 'document' || part.kind === 'resource') {
    const host = context.hostPort
    const sessionId = context.input().sessionId
    return <SolidFileReferenceCard part={part} actions={{
      canOpen: Boolean(sessionId && host?.capabilities.has('resourceOpen')),
      canReveal: Boolean(sessionId && host?.capabilities.has('resourceReveal')),
      canCopy: Boolean(sessionId && host?.capabilities.has('clipboardWrite')),
      open: target => { if (host && sessionId) void host.commands.openResource(sessionId, target) },
      reveal: target => { if (host && sessionId) void host.commands.revealResource(sessionId, target) },
      copyPath: path => { if (host && sessionId) void host.commands.copy(sessionId, path) },
    }} />
  }
  if (part.kind === 'image' || part.kind === 'audio' || part.kind === 'video') {
    const host = context.hostPort
    const sessionId = context.input().sessionId
    const canOpenExternal = Boolean(sessionId && host?.capabilities.has('resourceOpen'))
    return <SolidMediaBlock
      part={part}
      resolverOptions={BUILTIN_MEDIA_RESOLVER_OPTIONS}
      onOpenExternal={canOpenExternal && host && sessionId
        ? url => { void host.commands.openResource(sessionId, { uri: url }) }
        : undefined}
      onDownload={canOpenExternal && host && sessionId
        ? mediaPart => { void host.commands.openResource(sessionId, { ...mediaPart, disposition: 'download' }) }
        : undefined}
    />
  }
  if (part.kind === 'search-result' || part.kind === 'link') {
    const commands = fallbackRenderCommands(context)
    return <SolidSearchOrLink part={part} actions={{
      open: commands.canExecute?.('resource.open') ? url => { void commands.execute({ type: 'resource.open', payload: { uri: url } }) } : undefined,
      copy: commands.canExecute?.('clipboard.write') ? text => { void commands.execute({ type: 'clipboard.write', payload: { text } }) } : undefined,
    }} appearance={{ reducedMotion: context.input().reducedMotion }} />
  }
  if (part.kind === 'diff') {
    const snapshot = isValidDiffContentInput(part) ? diffSnapshotFromPart(part) : null
    return snapshot
      ? <SolidDiffContent snapshot={snapshot} nodeId={`fallback:${snapshot.path ?? snapshot.oldPath ?? 'diff'}`}
          appearance={{ ...context.appearanceSnapshot(), reducedMotion: context.input().reducedMotion }}
          commands={fallbackRenderCommands(context)} />
      : <pre class="solid-content-unknown" data-content-kind="diff">Invalid content.diff payload</pre>
  }
  if (part.kind === 'diagnostic-lsp') {
    return isValidLspDiagnosticContentInput(part)
      ? <SolidLspDiagnosticContent diagnostic={part as LspDiagnosticContentPart}
          appearance={{ ...context.appearanceSnapshot(), reducedMotion: context.input().reducedMotion }}
          commands={fallbackRenderCommands(context)} />
      : <pre class="solid-content-unknown" data-content-kind="diagnostic-lsp">Invalid diagnostic.lsp payload</pre>
  }
  if (part.kind === 'terminal') {
    const commands = fallbackRenderCommands(context)
    return <SolidTerminalBlock part={part} appearance={{ ...context.appearanceSnapshot(), reducedMotion: context.input().reducedMotion }} actions={{
      copy: commands.canExecute?.('clipboard.write')
        ? text => { void commands.execute({ type: 'clipboard.write', payload: { text } }) }
        : undefined,
    }} />
  }
  if (part.kind === 'log') {
    return <SolidLogBlock part={part} appearance={{ ...context.appearanceSnapshot(), reducedMotion: context.input().reducedMotion }} />
  }
  if (part.kind === 'memory' || part.kind === 'skill' || part.kind === 'mcp-resource' || part.kind === 'artifact') {
    return <SolidExtensionContentCard
      kind={`content.${part.kind}`}
      payload={part}
      appearance={{ ...context.appearanceSnapshot(), reducedMotion: context.input().reducedMotion === true }}
      commands={fallbackRenderCommands(context)}
    />
  }
  const structuredKind = part.kind.includes('.') ? part.kind : `content.${part.kind}`
  if (isStructuredContentKind(structuredKind)) {
    return <SolidStructuredContent kind={structuredKind} payload={part} commands={fallbackRenderCommands(context)}
      renderPart={nested => renderBuiltinContentPart(nested, inline, context, false)} />
  }
  if (part.kind === 'unknown') {
    return <SolidUnknownContent part={part} commands={fallbackRenderCommands(context)} />
  }
  const summary = `Unsupported content kind: ${part.kind}`
  return <pre class="solid-content-unknown" data-content-kind={part.kind}>{summary}</pre>
}

export function renderExtensionFallback(extension: WorkbenchExtensionNode, context: SolidWorkbenchContextValue) {
  const provenance = <div class="solid-extension-provenance">
    <small>{extension.source.provider} · {extension.source.sourceId}</small>
    <small>{extension.provenance.origin} · {extension.provenance.trust}</small>
  </div>
  if (extension.kind === 'system.hook' && isValidHookSurfaceInput(extension.payload)) {
    return <section class="solid-extension-fallback" data-extension-kind={extension.kind}>
      {provenance}
      <SolidExtensionContentCard
        kind="system.hook"
        payload={extension.payload}
        appearance={{ ...context.appearanceSnapshot(), reducedMotion: context.input().reducedMotion === true }}
        commands={fallbackRenderCommands(context)}
      />
    </section>
  }
  const fallback = extension.fallback.length > 0
    ? extension.fallback
    : [{ kind: 'unknown', originalType: extension.kind, summary: `Unsupported extension: ${extension.kind}`, raw: {}, truncated: false }] as const
  return <section class="solid-extension-fallback" role="note" aria-label={`扩展事件：${extension.kind}`} data-extension-kind={extension.kind}>
    <strong>{extension.kind}</strong>
    {provenance}
    <For each={coalesceAdjacentDisplayTextParts(fallback)}>{part => renderBuiltinContentPart(part, false, context)}</For>
  </section>
}
