/** @jsxImportSource solid-js */
import { Show, createSignal, onCleanup } from 'solid-js'
import { createSolidMount } from '../../host/solidBridge.solid'
import { getSkinRuntime } from '../../infrastructure/skin/skinRuntimeServices'
import { skinTargetKey, type SkinRuntime } from '../../plugin-runtime/skin/skinRuntime'
import type { SkinPatch, SkinTarget } from '../../plugin-runtime/skin/skinTypes'

export interface SkinPreviewBarProps {
  runtime?: SkinRuntime
}

function describeTarget(target: SkinTarget): string {
  switch (target.scope) {
    case 'global':
      return '全局'
    case 'workspace':
      return `工作区 ${target.workspaceId}`
    case 'agent':
      return `Agent ${target.agentId}`
    case 'session':
      return `会话 ${target.sessionId}`
  }
}

/**
 * SkinPreviewBar — 最小可用 preview 人工作业面（阶段 5 S5-D，#515 Solid 实体）。
 *
 * 仅在存在 active preview 时渲染；动作只调用 Skin Runtime，不直改 Store/DOM。
 * 默认挂载在 Kernel/Application 边界内（KernelRoot），不随 App 卸载而丢失。
 *
 * 样式：原 SkinPreviewBar.css 已整文件绞杀进 utilities 层（#491 绞杀恢复批）。
 * 根上的 `skin-preview-bar` 类名保留为纯锚点——零 CSS 规则，仅供测试与调试定位。
 */
export default function SkinPreviewBar(props: SkinPreviewBarProps) {
  // React 版默认参数的等价：未注入 runtime 时取全局单例（组件体只跑一次，仅取一次）。
  const runtime = () => props.runtime ?? getSkinRuntime()
  const [snapshot, setSnapshot] = createSignal(runtime().getSnapshot())
  onCleanup(runtime().subscribe(() => setSnapshot(() => runtime().getSnapshot())))

  const [patchText, setPatchText] = createSignal('')
  const [patchError, setPatchError] = createSignal<string | null>(null)

  const preview = () => snapshot().activePreview
  const draft = () => {
    const current = preview()
    return current ? runtime().getDraft(current.draftId) : undefined
  }

  const applyPatch = () => {
    const currentDraft = draft()
    if (!currentDraft) return
    try {
      const patch = JSON.parse(patchText() || '{}') as SkinPatch
      runtime().patchDraft(currentDraft.draftId, patch)
      setPatchText('')
      setPatchError(null)
    } catch (error) {
      setPatchError(error instanceof Error ? error.message : String(error))
    }
  }

  const requestCommit = () => {
    const current = preview()
    const currentDraft = draft()
    if (!current || !currentDraft) return
    // D-007：永久应用默认需要用户确认，不静默 commit。
    if (window.confirm(`确定永久应用皮肤「${currentDraft.name}」到${describeTarget(current.target)}吗？`)) {
      runtime().commit(current.previewId)
    }
  }

  const buttonClasses =
    'cursor-pointer rounded-md border border-stroke-subtle bg-transparent px-2.5 py-1 text-sm'

  return (
    <Show when={preview() && draft()}>
      <div
        class="skin-preview-bar fixed bottom-4 left-1/2 z-[1000] flex max-w-[calc(100vw-32px)] -translate-x-1/2 items-center gap-2 rounded-[10px] border border-accent bg-surface-overlay px-3 py-2 text-sm leading-[1.4] shadow-[var(--shadow-soft)]"
        data-pylon-component="skin-preview-bar"
        data-skin-preview-id={preview()!.previewId}
        data-skin-target={skinTargetKey(preview()!.target)}
        role="region"
        aria-label="Skin 预览"
      >
        <span class="font-bold">Skin 预览</span>
        <span>{draft()!.name}</span>
        <span>{describeTarget(preview()!.target)}</span>
        <span
          class="data-[valid=invalid]:text-danger data-[valid=valid]:text-success"
          data-valid={draft()!.status}
        >
          {draft()!.status}
        </span>
        <span>rev {draft()!.revision}</span>
        <input
          class="w-[220px] rounded-md border border-stroke-subtle px-1.5 py-1 font-mono text-xs"
          value={patchText()}
          onInput={event => setPatchText(event.currentTarget.value)}
          placeholder='{"tokens":{"accent":"#ff0000"}}'
          aria-label="Skin patch JSON"
        />
        <button type="button" class={buttonClasses} onClick={applyPatch}>继续调整</button>
        <button type="button" class={buttonClasses} onClick={() => { const current = preview(); if (current) runtime().rollback(current.previewId) }}>撤销预览</button>
        <button type="button" class={`${buttonClasses} border-accent font-bold text-accent`} onClick={requestCommit}>确认应用</button>
        <Show when={patchError()}>
          <span class="max-w-[240px] text-danger" role="alert">{patchError()}</span>
        </Show>
      </div>
    </Show>
  )
}

/** React 薄桥（SkinPreviewBar.tsx）的挂载工厂：Solid JSX 只允许出现在本文件。 */
export const mountSkinPreviewBar = createSolidMount(SkinPreviewBar)
