import { createSignal, onCleanup } from 'solid-js'
import type { Accessor } from 'solid-js'

/**
 * createCopyFeedback — 「已复制 ✓」一次性反馈计时器（Solid hook）。
 *
 * #228 批次D 收敛 chat 复制按钮的复制粘贴计时器（MessageRow AssistantContent；
 * CodeBlock.solid.tsx 同形副本因 #221 在途文件域暂未接入，后续替换其
 * copied/copiedTimer/copy 三段即可）。markCopied 连点重置计时（pending timer
 * 先清后设），组件卸载经 onCleanup 回收。
 * 落点说明：solid-workbench 子树内非 .solid.tsx 文件禁止 import solid-js
 * （check-solid-workbench-boundaries），故 hook 放本模块而非 chat/ 目录。
 */
export function createCopyFeedback(resetMs = 2000): { copied: Accessor<boolean>; markCopied: () => void } {
  const [copied, setCopied] = createSignal(false)
  let copiedTimer: number | undefined
  onCleanup(() => {
    if (copiedTimer !== undefined) window.clearTimeout(copiedTimer)
  })
  const markCopied = (): void => {
    setCopied(true)
    if (copiedTimer !== undefined) window.clearTimeout(copiedTimer)
    copiedTimer = window.setTimeout(() => setCopied(false), resetMs)
  }
  return { copied, markCopied }
}
