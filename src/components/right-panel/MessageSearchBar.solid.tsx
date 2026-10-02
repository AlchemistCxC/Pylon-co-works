/** @jsxImportSource solid-js */
import { onMount, Show } from 'solid-js'
import { LucideIcon } from '../LucideIcon.solid.tsx'
import type { MessageSearchBarProps } from './rightPanelTypes.ts'

export type { MessageSearchBarProps }

const navButton = 'inline-flex items-center justify-center shrink-0 w-[var(--ui-control-compact)] h-[var(--ui-control-compact)] p-0 border-0 rounded-none cursor-pointer text-text-dim bg-transparent enabled:hover:text-text enabled:hover:bg-border disabled:opacity-35 disabled:cursor-default focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent'

/** MessageSearchBar — 消息搜索条（#515 Solid 实体；DOM/键盘/aria 契约与 React 版逐字同构）。 */
export default function MessageSearchBar(props: MessageSearchBarProps) {
  let inputRef: HTMLInputElement | undefined

  onMount(() => {
    inputRef?.focus()
    inputRef?.select()
  })

  return (
    <div
      class="sticky top-[10px] z-[8] flex items-center gap-1.5 w-[min(420px,calc(100%-20px))] min-h-[var(--ui-control-standard)] mx-auto mb-2 py-1 pr-1.5 pl-2.5 text-text-dim bg-bg-panel border border-border rounded-none shadow-[0_4px_16px_rgba(0,0,0,0.12)] focus-within:border-accent focus-within:shadow-[0_0_0_3px_var(--accent-soft)] [.layout>.context-panel-body_&]:static [.layout>.context-panel-body_&]:w-full [.layout>.context-panel-body_&]:mx-0 [.layout>.context-panel-body_&]:mb-3 [.layout>.context-panel-body_&]:shadow-none"
      role="search"
      aria-label="搜索当前会话消息"
    >
      <LucideIcon name="Search" size={15} />
      <input
        ref={element => { inputRef = element }}
        value={props.query}
        onInput={event => props.onQueryChange(event.currentTarget.value)}
        onKeyDown={event => {
          if (event.key === 'Enter') {
            event.preventDefault()
            if (event.shiftKey) props.onPrevious()
            else props.onNext()
          }
          if (event.key === 'Escape') {
            event.preventDefault()
            props.onClose()
          }
        }}
        placeholder="搜索消息"
        aria-label="搜索消息"
        class="min-w-0 flex-1 border-0 outline-none bg-transparent text-text text-[13px] leading-[1.4] font-[family-name:var(--font)] placeholder:text-text-dim"
      />
      <span class="shrink-0 min-w-[42px] text-right text-sm" aria-live="polite">
        <Show when={props.query.trim() && props.matchCount > 0} fallback={<Show when={props.query.trim()}>无结果</Show>}>
          {props.matchIndex + 1}/{props.matchCount}
        </Show>
      </span>
      <button type="button" class={navButton} onClick={() => props.onPrevious()} disabled={props.matchCount === 0} aria-label="上一个搜索结果" title="上一个结果（Shift+Enter）">
        <LucideIcon name="ChevronUp" size={15} />
      </button>
      <button type="button" class={navButton} onClick={() => props.onNext()} disabled={props.matchCount === 0} aria-label="下一个搜索结果" title="下一个结果（Enter）">
        <LucideIcon name="ChevronDown" size={15} />
      </button>
      <button type="button" class={navButton} onClick={() => props.onClose()} aria-label="关闭消息搜索" title="关闭（Esc）">
        <LucideIcon name="X" size={15} />
      </button>
    </div>
  )
}
