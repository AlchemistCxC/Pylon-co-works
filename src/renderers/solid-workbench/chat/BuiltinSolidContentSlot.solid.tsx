import { Match, Switch } from 'solid-js'
import type {
  RenderAppearanceSnapshot,
  RenderCommandPort,
  RenderNodeSnapshot,
} from '../../../contracts/messageRenderer.ts'
import type { ContentPart } from '../../../domains/workbench/content/contentPartSchema.ts'
import { SolidAnsiBlock } from './AnsiBlock.solid.tsx'
import { SolidCodeBlock } from './CodeBlock.solid.tsx'
import { MarkdownContent } from './MarkdownContent.solid.tsx'
import { ReasoningBlock } from './MessageRow.solid.tsx'
import { SolidFileReferenceCard } from './content/FileReference.solid.tsx'
import { SolidMediaBlock } from './content/MediaBlock.solid.tsx'
import { BUILTIN_MEDIA_RESOLVER_OPTIONS } from '../mediaAssetAdapter.ts'

export function BuiltinSolidContentSlot(props: {
  snapshot: RenderNodeSnapshot
  appearance: RenderAppearanceSnapshot
  commands: RenderCommandPort
}) {
  const kind = () => props.snapshot.kind
  const payload = () => props.snapshot.payload as ContentPart
  const record = () => props.snapshot.payload as Record<string, unknown>
  const text = () => typeof record().text === 'string' ? record().text as string : ''
  const can = (commandType: string) => props.commands.canExecute?.(commandType) === true
  const execute = (type: string, payloadValue: unknown) => {
    void props.commands.execute({ type, payload: payloadValue })
  }
  const numberSetting = (key: string, fallback: number) => typeof props.appearance[key] === 'number'
    ? props.appearance[key] as number
    : fallback
  const stringSetting = (key: string, fallback: string) => typeof props.appearance[key] === 'string'
    ? props.appearance[key] as string
    : fallback
  const booleanSetting = (key: string, fallback: boolean) => typeof props.appearance[key] === 'boolean'
    ? props.appearance[key] as boolean
    : fallback
  const fontFamily = () => {
    switch (props.appearance.fontFamily) {
      case 'mono': return 'var(--mono)'
      case 'sans': return 'var(--font)'
      case 'serif': return 'serif'
      default: return 'inherit'
    }
  }
  const contentStyle = () => ({
    'font-family': fontFamily(),
    'font-size': `${numberSetting('fontSize', 14)}px`,
    'line-height': String(numberSetting('lineHeight', 1.6)),
    'max-width': `${numberSetting('maxWidth', 1600)}px`,
  })

  return (
    <div
      class="solid-content-kind"
      data-content-kind={kind()}
      data-link-style={stringSetting('linkStyle', 'underline')}
      style={contentStyle()}
    >
      <Switch fallback={
        <pre class="solid-content-unknown">{unknownSummary(props.snapshot.payload, kind())}</pre>
      }>
      <Match when={kind() === 'content.text' || kind() === 'content.markdown'}>
        <MarkdownContent text={text()} />
      </Match>
      <Match when={kind() === 'content.code'}>
        <SolidCodeBlock
          code={text()}
          language={typeof record().language === 'string' ? record().language as string : undefined}
          maxLines={numberSetting('maxLines', 400)}
          showLanguage={booleanSetting('showLanguage', true)}
          showCopyButton={booleanSetting('showCopyButton', true)}
          wrap={stringSetting('wrap', 'soft') === 'none' ? 'none' : 'soft'}
          palette={stringSetting('palette', 'auto')}
        />
      </Match>
      <Match when={kind() === 'content.ansi'}>
        <SolidAnsiBlock
          text={text()}
          reducedMotion={props.appearance.reducedMotion === true}
          wrap={stringSetting('wrap', 'soft') === 'none' ? 'none' : 'soft'}
          maxLines={numberSetting('maxLines', 800)}
          background={stringSetting('background', 'transparent')}
          palette={stringSetting('palette', 'terminal')}
        />
      </Match>
      <Match when={kind() === 'content.reasoning'}>
        <ReasoningBlock
          text={text()}
          running={record().state === 'running'}
          durationMs={typeof record().durationMs === 'number' ? record().durationMs as number : undefined}
          foreground={stringSetting('foreground', 'var(--text-dim)')}
          background={stringSetting('background', 'transparent')}
          borderColor={stringSetting('borderColor', 'color-mix(in srgb, var(--border) 72%, transparent)')}
          fontSize={numberSetting('fontSize', 13)}
          lineHeight={numberSetting('lineHeight', 1.6)}
          defaultCollapsed={booleanSetting('defaultCollapsed', true)}
          maxHeight={numberSetting('maxHeight', 320)}
          runningAnimation={reasoningAnimation(props.appearance.runningAnimation)}
          showDuration={booleanSetting('showDuration', true)}
          reducedMotion={props.appearance.reducedMotion === true}
        />
      </Match>
      <Match when={kind() === 'content.redacted-reasoning'}>
        <ReasoningBlock
          text=""
          running={false}
          redacted
          redactedReason={typeof record().reason === 'string' ? record().reason as string : 'provider_redacted'}
          foreground={stringSetting('foreground', 'var(--text-dim)')}
          background={stringSetting('background', 'transparent')}
          borderColor={stringSetting('borderColor', 'color-mix(in srgb, var(--border) 72%, transparent)')}
          fontSize={numberSetting('fontSize', 13)}
          lineHeight={numberSetting('lineHeight', 1.6)}
          defaultCollapsed={booleanSetting('defaultCollapsed', true)}
          maxHeight={numberSetting('maxHeight', 320)}
          runningAnimation={reasoningAnimation(props.appearance.runningAnimation)}
          showDuration={booleanSetting('showDuration', true)}
          reducedMotion={props.appearance.reducedMotion === true}
        />
      </Match>
      <Match when={kind() === 'content.file-reference' || kind() === 'content.file-selection' || kind() === 'content.document' || kind() === 'content.resource'}>
        <SolidFileReferenceCard part={payload()} actions={{
          canOpen: can('resource.open'),
          canReveal: can('resource.reveal'),
          canCopy: can('clipboard.write'),
          open: target => execute('resource.open', target),
          reveal: target => execute('resource.reveal', target),
          copyPath: path => execute('clipboard.write', { text: path }),
        }} appearance={{
          foreground: stringSetting('foreground', 'var(--text)'),
          mutedForeground: stringSetting('mutedForeground', 'var(--text-dim)'),
          background: stringSetting('background', 'transparent'),
          borderColor: stringSetting('borderColor', 'var(--border)'),
          fontSize: numberSetting('fontSize', 13),
          iconSize: numberSetting('iconSize', 18),
          maxWidth: numberSetting('maxWidth', 960),
          maxHeight: numberSetting('maxHeight', 360),
          pathCollapse: filePathCollapse(props.appearance.pathCollapse),
          previewLines: numberSetting('previewLines', 12),
          showAbsolutePath: booleanSetting('showAbsolutePath', true),
          showMetadata: booleanSetting('showMetadata', true),
          fileTypePalette: fileTypePalette(props.appearance.fileTypePalette),
          groupLayout: fileGroupLayout(props.appearance.groupLayout),
        }} />
      </Match>
      <Match when={kind() === 'content.image' || kind() === 'content.audio' || kind() === 'content.video'}>
        <SolidMediaBlock
          part={payload()}
          resolverOptions={BUILTIN_MEDIA_RESOLVER_OPTIONS}
          onOpenExternal={can('resource.open') ? url => execute('resource.open', { uri: url }) : undefined}
          onDownload={can('resource.open') ? part => execute('resource.open', { ...part, disposition: 'download' }) : undefined}
          appearance={{
            foreground: stringSetting('foreground', 'var(--text)'),
            mutedForeground: stringSetting('mutedForeground', 'var(--text-dim)'),
            background: stringSetting('background', 'transparent'),
            borderColor: stringSetting('borderColor', 'var(--border)'),
            maxWidth: numberSetting('maxWidth', 960),
            maxHeight: numberSetting('maxHeight', 640),
            fit: mediaFit(props.appearance.fit),
            radius: numberSetting('radius', 8),
            defaultExpanded: booleanSetting('defaultExpanded', true),
            showCaption: booleanSetting('showCaption', true),
            showDownload: booleanSetting('showDownload', true),
            autoplay: booleanSetting('autoplay', false),
            controls: booleanSetting('controls', true),
            transcriptStyle: mediaTranscriptStyle(props.appearance.transcriptStyle),
            showMetadata: booleanSetting('showMetadata', true),
            reducedMotion: props.appearance.reducedMotion === true,
          }}
        />
      </Match>
      <Match when={kind() === 'content.unknown'}>
        <pre class="solid-content-unknown" data-content-kind={kind()}>{unknownSummary(props.snapshot.payload, kind())}</pre>
      </Match>
      </Switch>
    </div>
  )
}

function reasoningAnimation(value: unknown): 'pulse' | 'shimmer' | 'none' {
  return value === 'shimmer' || value === 'none' ? value : 'pulse'
}

function filePathCollapse(value: unknown): 'full' | 'middle' | 'basename' {
  return value === 'full' || value === 'basename' ? value : 'middle'
}

function fileTypePalette(value: unknown): 'auto' | 'neutral' | 'accent' {
  return value === 'neutral' || value === 'accent' ? value : 'auto'
}

function fileGroupLayout(value: unknown): 'stack' | 'grid' {
  return value === 'grid' ? 'grid' : 'stack'
}

function mediaFit(value: unknown): 'contain' | 'cover' | 'original' {
  return value === 'cover' || value === 'original' ? value : 'contain'
}

function mediaTranscriptStyle(value: unknown): 'panel' | 'plain' | 'compact' {
  return value === 'plain' || value === 'compact' ? value : 'panel'
}

function unknownSummary(payload: unknown, kind: string): string {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const summary = (payload as Record<string, unknown>).summary
    if (typeof summary === 'string' && summary.trim()) return summary
  }
  return `Unsupported content kind: ${kind}`
}
