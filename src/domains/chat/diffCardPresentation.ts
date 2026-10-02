/**
 * diffCardPresentation — DiffCard 的 utility 常量单源（结构审查 A-V7）。
 *
 * 历史上 React `components/file/DiffCard.tsx` 与 Solid `renderers/solid-workbench/chat/DiffCard.solid.tsx`
 * 各持一份逐字相同的常量组（P92 样式绞杀的机械翻译产物），故把框架无关的纯字符串常量
 * 收拢本模块；#515 起 React 原件已退役，DiffCard 唯一实体是 `DiffCard.solid.tsx`，
 * 本模块即其常量面。调色板变量（--diff-*，主题可供给）连同 hex 兜底原样平移；
 * 字面量 rgba 为存量值保留。
 */

export const DIFF_CARD = 'mt-1 mb-1.5 rounded-none overflow-hidden border border-border bg-[var(--chat-code-bg,rgba(0,0,0,0.02))]'
export const DIFF_HEAD = 'w-full flex justify-between gap-3 py-[5px] px-2 border-0 text-text bg-transparent [font:inherit] text-left cursor-pointer hover:bg-border'
export const DIFF_COUNT = 'text-text-dim text-[0.85em]'
export const DIFF_BODY = 'max-h-[320px] overflow-auto font-mono text-[0.9em] leading-[1.5]'
export const DIFF_LINE = 'flex min-w-max pr-2.5 whitespace-pre'
export const DIFF_SIGN = 'w-6 shrink-0 pl-2 text-text-dim select-none'

export const DIFF_LINE_BG: Partial<Record<'context' | 'added' | 'removed', string>> = {
  added: 'bg-[color-mix(in_srgb,var(--diff-added,#4EBA65)_14%,transparent)]',
  removed: 'bg-[color-mix(in_srgb,var(--diff-removed,#FF6B80)_14%,transparent)]',
}

export const DIFF_SIGN_TONE: Record<'added' | 'removed', string> = {
  added: 'text-[var(--diff-added,#4EBA65)]',
  removed: 'text-[var(--diff-removed,#FF6B80)]',
}

export const WORD_BASE = 'rounded-none'

export const WORD_TONE: Record<'added' | 'removed', string> = {
  added: 'bg-[var(--diff-added-word,#3EA15E)] text-white',
  removed: 'bg-[var(--diff-removed-word,#E0556B)] text-white',
}

export const CODE_INHERIT = '[font:inherit]'
