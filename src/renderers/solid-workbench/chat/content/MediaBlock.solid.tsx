import { Show, createMemo, createSignal, type JSX } from 'solid-js'
import type { ContentPart, ImageContentPart } from '../../../../domains/workbench/content/contentPartSchema.ts'
import {
  isAllowedMediaPosterUrl,
  resolveMediaSource,
  type MediaSourceResolverOptions,
} from '../../../../domains/rendererContent/mediaSourceResolver.ts'
import { createCollapsiblePresenter } from '../CollapsiblePresenter.solid.tsx'

/**
 * C03：image/audio/video 媒体卡（Solid）。
 *
 * 卡面规则：
 * - image 有 placeholder/loading/error/zoom；audio/video 用原生 controls 且默认不 autoplay；
 * - 加载失败保留 metadata 并提供 retry；
 * - source 一律经 mediaSourceResolver 解析（协议白名单/adapter/限额），组件不做裸字符串拼装；
 * - transcript 作为关联文本呈现，不与媒体 payload 混合。
 */

export interface SolidMediaBlockProps {
  part: ContentPart
  /** host asset adapter（Tauri convertFileSrc）；缺省时本地路径 fail closed。 */
  resolverOptions?: MediaSourceResolverOptions
  onOpenExternal?: (url: string) => void
  onDownload?: (part: ImageContentPart) => void
  appearance?: Partial<SolidMediaAppearance>
}

type MediaKind = 'image' | 'audio' | 'video'

export interface SolidMediaAppearance {
  foreground: string
  mutedForeground: string
  background: string
  borderColor: string
  maxWidth: number
  maxHeight: number
  fit: 'contain' | 'cover' | 'original'
  radius: number
  defaultExpanded: boolean
  showCaption: boolean
  showDownload: boolean
  autoplay: boolean
  controls: boolean
  transcriptStyle: 'panel' | 'plain' | 'compact'
  showMetadata: boolean
  reducedMotion: boolean
}

const DEFAULT_APPEARANCE: SolidMediaAppearance = Object.freeze({
  foreground: 'var(--text)',
  mutedForeground: 'var(--text-dim)',
  background: 'transparent',
  borderColor: 'var(--border)',
  maxWidth: 960,
  maxHeight: 640,
  fit: 'contain',
  radius: 8,
  defaultExpanded: true,
  showCaption: true,
  showDownload: true,
  autoplay: false,
  controls: true,
  transcriptStyle: 'panel',
  showMetadata: true,
  reducedMotion: false,
})

export function SolidMediaBlock(props: SolidMediaBlockProps) {
  let mediaElement: HTMLMediaElement | HTMLImageElement | undefined
  const [status, setStatus] = createSignal<'loading' | 'ready' | 'error'>('loading')
  const [zoomed, setZoomed] = createSignal(false)
  const [attempt, setAttempt] = createSignal(0)
  const appearance = createMemo<SolidMediaAppearance>(() => ({
    ...DEFAULT_APPEARANCE,
    ...props.appearance,
  }))
  const configuredDefaultExpanded = createMemo(() => appearance().defaultExpanded)
  const collapse = createCollapsiblePresenter({
    defaultOpen: configuredDefaultExpanded,
    resetOnDefaultChange: true,
    idPrefix: 'solid-media',
  })

  const parsed = createMemo<ImageContentPart | undefined>(() => {
    const part = props.part
    return part.kind === 'image' || part.kind === 'audio' || part.kind === 'video' ? part : undefined
  })

  const kind = () => {
    const value = parsed()?.kind
    return value === 'image' || value === 'audio' || value === 'video' ? value : null
  }

  const resolved = createMemo(() => {
    void attempt()
    if (!kind()) return { ok: false as const, reason: '非媒体 part' }
    const p = parsed()!
    // Canonical sourceKind owns path/base64/blob classification. Older
    // standard URL parts without sourceKind remain supported.
    const sourceValue = p.source.trim()
    const sourceIsDataUrl = sourceValue ? /^data:/i.test(sourceValue) : false
    return resolveMediaSource(
      {
        url: p.sourceKind === 'url' || p.sourceKind === 'blob' || !p.sourceKind || sourceIsDataUrl
          ? sourceValue
          : undefined,
        localPath: p.sourceKind === 'path' ? sourceValue : undefined,
        base64: p.sourceKind === 'base64'
          ? sourceValue
          : undefined,
        mime: p.mimeType,
      },
      props.resolverOptions,
    )
  })

  const altText = () => parsed()?.alt || parsed()?.caption || `(${kind()} 内容)`
  const mediaLabel = () => kind() === 'image' ? '图片' : kind() === 'audio' ? '音频' : '视频'
  const safePoster = () => {
    const poster = parsed()?.poster?.trim()
    return poster && isAllowedMediaPosterUrl(poster) ? poster : undefined
  }
  const dimensionLabel = () => {
    const p = parsed()!
    const segments: string[] = []
    if (p.width !== undefined && p.height !== undefined) segments.push(`${p.width}×${p.height}`)
    if (p.durationMs !== undefined) segments.push(formatDuration(p.durationMs))
    if (p.mimeType) segments.push(p.mimeType)
    return segments.join(' · ')
  }

  const retry = () => {
    setStatus('loading')
    setAttempt(value => value + 1)
    if (mediaElement instanceof HTMLMediaElement) mediaElement.load()
    else if (mediaElement instanceof HTMLImageElement) {
      const source = resolved()
      mediaElement.removeAttribute('src')
      if (source.ok) mediaElement.src = source.source
    }
  }

  return (
    <Show when={kind()} fallback={null}>
      <figure
        class="term-media"
        aria-label={`${mediaLabel()}：${altText()}`}
        data-media-kind={kind()}
        data-status={status()}
        data-fit={appearance().fit}
        data-expanded={collapse.open() ? 'true' : 'false'}
        data-transcript-style={appearance().transcriptStyle}
        data-reduced-motion={appearance().reducedMotion ? 'true' : 'false'}
        style={{
          color: appearance().foreground,
          'background-color': appearance().background,
          'border-color': appearance().borderColor,
          'max-width': `${appearance().maxWidth}px`,
          'border-radius': `${appearance().radius}px`,
        }}
      >
        <button
          class="term-media-disclosure"
          type="button"
          aria-expanded={collapse.open()}
          aria-label={`${collapse.open() ? '折叠' : '展开'}媒体：${altText()}`}
          onClick={collapse.toggle}
        >
          <span aria-hidden="true">{collapse.open() ? '▾' : '▸'}</span>
          <span>{mediaLabel()}</span>
        </button>
        <Show when={collapse.open()}>
          <Show
            when={resolved().ok}
            fallback={
              <div class="term-media-error" role="alert">
                <span class="term-media-error-text">媒体无法加载：{(resolved() as { reason: string }).reason}</span>
                <span class="term-file-meta-line">{dimensionLabel()}</span>
                <button class="term-file-action" type="button" onClick={retry}>重试</button>
              </div>
            }
          >
            <MediaBody
              kind={kind()!}
              src={(resolved() as { ok: true; source: string }).source}
              alt={altText()}
              poster={safePoster()}
              onElement={element => { mediaElement = element }}
              onReady={() => setStatus('ready')}
              onError={() => setStatus('error')}
              zoomed={zoomed()}
              onToggleZoom={() => setZoomed(value => !value)}
              maxWidth={appearance().maxWidth}
              maxHeight={appearance().maxHeight}
              fit={appearance().fit}
              radius={appearance().radius}
              autoplay={appearance().autoplay}
              controls={appearance().controls}
            />
          </Show>
          <figcaption class="term-media-caption">
            <Show when={appearance().showCaption && parsed()?.caption}>
              {caption => <span class="term-media-caption-text">{caption()}</span>}
            </Show>
            <Show when={appearance().showMetadata && dimensionLabel()}>
              {meta => <span class="term-file-meta-line">{meta()}</span>}
            </Show>
            <Show when={props.onOpenExternal && resolved().ok && (resolved() as { sourceKind?: string }).sourceKind === 'url'}>
              <button class="term-file-action" type="button" onClick={() => props.onOpenExternal?.((resolved() as { ok: true; source: string }).source)}>
                打开外部链接
              </button>
            </Show>
            <Show when={appearance().showDownload}>
              <button
                class="term-file-action"
                type="button"
                disabled={!props.onDownload || !resolved().ok}
                title={!props.onDownload ? '下载能力未接入' : !resolved().ok ? '媒体来源不可用' : undefined}
                onClick={() => {
                  if (props.onDownload && resolved().ok) props.onDownload(props.part as ImageContentPart)
                }}
              >下载</button>
            </Show>
            <Show when={status() === 'error'}>
              <button class="term-file-action" type="button" onClick={retry}>重试</button>
            </Show>
          </figcaption>
          <Show when={parsed()?.transcript}>
            {transcript => (
              <div
                class="term-media-transcript"
                data-transcript-style={appearance().transcriptStyle}
                style={{ color: appearance().mutedForeground }}
              >
                <span class="term-media-transcript-label">转写</span>
                <div class="term-media-transcript-body">{transcript()}</div>
              </div>
            )}
          </Show>
        </Show>
      </figure>
    </Show>
  )
}

function MediaBody(props: {
  kind: MediaKind
  src: string
  alt: string
  poster?: string
  zoomed: boolean
  onElement: (element: HTMLMediaElement | HTMLImageElement) => void
  onReady: () => void
  onError: () => void
  onToggleZoom: () => void
  maxWidth: number
  maxHeight: number
  fit: SolidMediaAppearance['fit']
  radius: number
  autoplay: boolean
  controls: boolean
}) {
  const mediaStyle = (): JSX.CSSProperties => ({
    'max-width': `${props.maxWidth}px`,
    'max-height': `${props.maxHeight}px`,
    'object-fit': props.fit === 'original' ? 'none' : props.fit,
    'border-radius': `${props.radius}px`,
  })
  return (
    <Show
      when={props.kind === 'image'}
      fallback={
        <Show
          when={props.kind === 'audio'}
          fallback={
            <video
              class="term-media-element"
              ref={props.onElement}
              src={props.src}
              poster={props.poster}
              controls={props.controls}
              autoplay={props.autoplay}
              preload="metadata"
              aria-label={props.alt}
              style={mediaStyle()}
              onLoadedMetadata={props.onReady}
              onError={props.onError}
            />
          }
        >
          <audio
            class="term-media-element term-media-audio"
            ref={props.onElement}
            src={props.src}
            controls={props.controls}
            autoplay={props.autoplay}
            preload="metadata"
            aria-label={props.alt}
            style={mediaStyle()}
            onLoadedMetadata={props.onReady}
            onError={props.onError}
          />
        </Show>
      }
    >
      {/* C03：image 点击切换 zoom；键盘可达（button 包裹） */}
      <button
        class={`term-media-image-button${props.zoomed ? ' term-media-zoomed' : ''}`}
        type="button"
        onClick={props.onToggleZoom}
        aria-pressed={props.zoomed}
        aria-label={`${props.alt}（点击缩放）`}
      >
        <img
          class="term-media-element term-media-img"
          ref={props.onElement}
          src={props.src}
          alt={props.alt}
          loading="lazy"
          decoding="async"
          style={mediaStyle()}
          onLoad={props.onReady}
          onError={props.onError}
        />
      </button>
    </Show>
  )
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.round(Math.max(0, ms) / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return minutes > 0 ? `${minutes}m${seconds}s` : `${seconds}s`
}
