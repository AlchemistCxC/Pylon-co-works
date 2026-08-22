import { Show, createMemo } from 'solid-js'
import type { ContentPart } from '../../../../domains/workbench/content/contentPartSchema.ts'

/**
 * C02：文件引用/选择区/资源卡（Solid）。
 *
 * 卡面要求：显示路径、范围、摘要和来源；动作（open/reveal/copy）经 command port
 * capability，不可用时 disabled 并解释原因；PDF/二进制只显示安全 metadata。
 * 路径保持原样呈现——不做 Windows/URI 字符串猜测互转。
 */

export interface FileReferenceActions {
  /** command port capability 快照；缺失的动作用 disabled + 原因呈现。 */
  canOpen?: boolean
  canReveal?: boolean
  canCopy?: boolean
  open?: (target: unknown) => void
  reveal?: (target: unknown) => void
  copyPath?: (path: string) => void
}

function selectionLabel(selection: { start?: { line?: number; column?: number }; end?: { line?: number; column?: number } } | undefined): string | undefined {
  if (!selection) return undefined
  const start = selection.start?.line !== undefined ? `L${selection.start.line}${selection.start.column !== undefined ? `:${selection.start.column}` : ''}` : undefined
  const end = selection.end?.line !== undefined ? `L${selection.end.line}` : undefined
  if (start && end && start !== end) return `${start}–${end}`
  return start ?? end
}

export function SolidFileReferenceCard(props: { part: ContentPart; actions?: FileReferenceActions }) {
  const part = createMemo(() => props.part)

  return (
    <Show
      when={part().kind === 'file-reference' || part().kind === 'file-selection'}
      fallback={<SolidResourceCard part={part()} actions={props.actions} />}
    >
      <div class="term-file-card" data-part-kind={part().kind}>
        <span class="term-file-icon" aria-hidden="true">📄</span>
        <div class="term-file-meta">
          <span class="term-file-name">{displayTitle(part())}</span>
          <span class="term-file-path">{(part() as unknown as { path: string }).path}</span>
          <Show when={part().kind === 'file-selection'}>
            <span class="term-file-range">{rangeText(part() as unknown as { selection?: { start?: { line?: number; column?: number }; end?: { line?: number; column?: number } } })}</span>
          </Show>
          <Show when={metaLine(part())}>
            {meta => <span class="term-file-meta-line">{meta()}</span>}
          </Show>
        </div>
        <div class="term-file-actions" role="group" aria-label="文件操作">
          <ActionButton
            label="打开"
            enabled={props.actions?.canOpen === true && props.actions?.open !== undefined}
            disabledReason="打开能力未接入"
            onClick={() => props.actions?.open?.(part())}
          />
          <ActionButton
            label="定位"
            enabled={props.actions?.canReveal === true && props.actions?.reveal !== undefined}
            disabledReason="定位能力未接入"
            onClick={() => props.actions?.reveal?.(part())}
          />
          <ActionButton
            label="复制路径"
            enabled={props.actions?.canCopy === true && props.actions?.copyPath !== undefined}
            disabledReason="剪贴板能力未接入"
            onClick={() => props.actions?.copyPath?.(asFileish(part()).path ?? '')}
          />
        </div>
      </div>
    </Show>
  )
}

function SolidResourceCard(props: { part: ContentPart; actions?: FileReferenceActions }) {
  const res = () => props.part as { kind: string; uri: string; title?: string; mimeType?: string; text?: string; hasBlob?: boolean }
  // C02 步骤5：二进制/PDF 只显示安全 metadata；blob 永不渲染
  const isBinary = () => res().hasBlob === true || (res().mimeType?.startsWith('application/') ?? false)
  return (
    <div class="term-file-card term-resource-card" data-part-kind={props.part.kind}>
      <span class="term-file-icon" aria-hidden="true">🔗</span>
      <div class="term-file-meta">
        <span class="term-file-name">{res().title || res().uri}</span>
        <span class="term-file-path">{res().uri}</span>
        <Show when={res().mimeType}>
          {mime => <span class="term-file-meta-line">{mime()}</span>}
        </Show>
        <Show when={isBinary()}>
          <span class="term-file-meta-line term-file-binary-note">二进制内容不内联展示</span>
        </Show>
      </div>
      <div class="term-file-actions" role="group" aria-label="资源操作">
        <ActionButton
          label="打开"
          enabled={props.actions?.canOpen === true && props.actions?.open !== undefined}
          disabledReason="打开能力未接入"
          onClick={() => props.actions?.open?.(props.part)}
        />
      </div>
    </div>
  )
}

function ActionButton(props: { label: string; enabled: boolean; disabledReason: string; onClick: () => void }) {
  return (
    <button
      class="term-file-action"
      type="button"
      disabled={!props.enabled}
      title={props.enabled ? props.label : props.disabledReason}
      aria-disabled={!props.enabled}
      onClick={props.onClick}
    >
      {props.label}
    </button>
  )
}

type FileishPart = { path?: string; displayName?: string; mime?: string; size?: number; language?: string; selection?: { start?: { line?: number; column?: number }; end?: { line?: number; column?: number } } }

function asFileish(part: ContentPart): FileishPart {
  return part as unknown as FileishPart
}

function displayTitle(part: ContentPart): string {
  const p = asFileish(part)
  if (!p.path) return ''
  return p.displayName || lastSegment(p.path)
}

function lastSegment(path: string): string {
  // 展示名取最后一段；路径本体仍完整保留在 .term-file-path
  const normalized = path.replace(/\\/g, '/')
  const segments = normalized.split('/').filter(Boolean)
  return segments[segments.length - 1] || path
}

function rangeText(part: FileishPart): string | undefined {
  return selectionLabel(part.selection)
}

function metaLine(part: ContentPart): string | undefined {
  const p = asFileish(part)
  const segments: string[] = []
  if (p.mime) segments.push(p.mime)
  if (p.size !== undefined) segments.push(formatBytes(p.size))
  if (part.kind === 'file-selection' && p.language) segments.push(p.language)
  return segments.join(' · ') || undefined
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}
