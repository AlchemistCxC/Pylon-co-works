import { Show, createMemo, createSignal } from 'solid-js'
import type { ContentPart } from '../../../../domains/workbench/content/contentPartSchema.ts'
import { resolveMediaSource, type MediaSourceResolverOptions } from '../../../../domains/rendererContent/mediaSourceResolver.ts'

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
}

type MediaKind = 'image' | 'audio' | 'video'

export function SolidMediaBlock(props: SolidMediaBlockProps) {
  const [status, setStatus] = createSignal<'loading' | 'ready' | 'error'>('loading')
  const [zoomed, setZoomed] = createSignal(false)
  const [attempt, setAttempt] = createSignal(0)

  const parsed = createMemo(() => {
    // attempt 变化触发 retry 重解析（source 不变，但让 onError 后可重新挂载）
    void attempt()
    return props.part as unknown as {
      kind: MediaKind
      source?: string
      url?: string
      localPath?: string
      base64?: string
      mimeType?: string
      mime?: string
      alt?: string
      caption?: string
      width?: number
      height?: number
      durationMs?: number
      poster?: string
      transcript?: string
    }
  })

  const kind = () => {
    const value = parsed().kind
    return value === 'image' || value === 'audio' || value === 'video' ? value : null
  }

  const resolved = createMemo(() => {
    if (!kind()) return { ok: false as const, reason: '非媒体 part' }
    const p = parsed()
    // wire 兼容：source 可能是 https URL、data:URL 或（受控环境）本地路径形态；
    // 分类交给 resolver——这里只负责把字段映射到对应输入槽。
    const sourceValue = p.source?.trim()
    const sourceIsDataUrl = sourceValue ? /^data:/i.test(sourceValue) : false
    return resolveMediaSource(
      {
        url: p.url ?? (sourceValue && !sourceIsDataUrl ? sourceValue : undefined),
        localPath: p.localPath,
        base64: p.base64 ?? (sourceIsDataUrl ? dataUrlBase64(sourceValue) : undefined),
        mime: p.mimeType ?? p.mime,
      },
      props.resolverOptions,
    )
  })

  const altText = () => parsed().alt || parsed().caption || `(${kind()} 内容)`
  const dimensionLabel = () => {
    const p = parsed()
    const segments: string[] = []
    if (p.width !== undefined && p.height !== undefined) segments.push(`${p.width}×${p.height}`)
    if (p.durationMs !== undefined) segments.push(formatDuration(p.durationMs))
    if (p.mimeType || p.mime) segments.push(p.mimeType || p.mime!)
    return segments.join(' · ')
  }

  const retry = () => {
    setStatus('loading')
    setAttempt(value => value + 1)
  }

  return (
    <Show when={kind()} fallback={null}>
      <figure class="term-media" data-media-kind={kind()} data-status={status()}>
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
            poster={parsed().poster}
            onReady={() => setStatus('ready')}
            onError={() => setStatus('error')}
            zoomed={zoomed()}
            onToggleZoom={() => setZoomed(value => !value)}
          />
        </Show>
        <figcaption class="term-media-caption">
          <Show when={parsed().caption}>
            {caption => <span class="term-media-caption-text">{caption()}</span>}
          </Show>
          <Show when={dimensionLabel()}>
            {meta => <span class="term-file-meta-line">{meta()}</span>}
          </Show>
          <Show when={props.onOpenExternal && resolved().ok && (resolved() as { sourceKind?: string }).sourceKind === 'url'}>
            <button class="term-file-action" type="button" onClick={() => props.onOpenExternal?.((resolved() as { ok: true; source: string }).source)}>
              打开外部链接
            </button>
          </Show>
          <Show when={status() === 'error'}>
            <button class="term-file-action" type="button" onClick={retry}>重试</button>
          </Show>
        </figcaption>
        <Show when={parsed().transcript}>
          {transcript => (
            <div class="term-media-transcript">
              <span class="term-media-transcript-label">转写</span>
              <div class="term-media-transcript-body">{transcript()}</div>
            </div>
          )}
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
  onReady: () => void
  onError: () => void
  onToggleZoom: () => void
}) {
  return (
    <Show
      when={props.kind === 'image'}
      fallback={
        <Show
          when={props.kind === 'audio'}
          fallback={
            <video
              class="term-media-element"
              src={props.src}
              poster={props.poster}
              controls
              autoplay={false}
              preload="metadata"
              aria-label={props.alt}
              onLoadStart={props.onReady}
              onError={props.onError}
            />
          }
        >
          <audio
            class="term-media-element term-media-audio"
            src={props.src}
            controls
            autoplay={false}
            preload="metadata"
            aria-label={props.alt}
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
          src={props.src}
          alt={props.alt}
          loading="lazy"
          decoding="async"
          onLoad={props.onReady}
          onError={props.onError}
        />
      </button>
    </Show>
  )
}

/** 兼容 wire 直接给 data: URL 的形态：拆出 base64 部分交给统一解析。 */
function dataUrlBase64(source: string | undefined): string | undefined {
  if (!source) return undefined
  const match = /^data:[^;,]+;base64,(.+)$/i.exec(source.trim())
  return match ? match[1]! : undefined
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.round(Math.max(0, ms) / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return minutes > 0 ? `${minutes}m${seconds}s` : `${seconds}s`
}
