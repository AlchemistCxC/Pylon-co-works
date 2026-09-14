import { useEffect, useRef } from 'react'
import { ChevronDown, ChevronUp, Search, X } from 'lucide-react'

// 样式绞杀（P92 地基后机械翻译）：原 MessageSearchBar.css 的 utility 化。
// 残留的 rgba 阴影为存量值原样平移（不新增档位）；context-panel 挂载域
// 的覆写用父级 arbitrary variant 原样保留。
interface Props {
  query: string
  matchIndex: number
  matchCount: number
  onQueryChange: (query: string) => void
  onPrevious: () => void
  onNext: () => void
  onClose: () => void
}

const navButton = 'inline-flex items-center justify-center shrink-0 w-[var(--ui-control-compact)] h-[var(--ui-control-compact)] p-0 border-0 rounded-none cursor-pointer text-text-dim bg-transparent enabled:hover:text-text enabled:hover:bg-border disabled:opacity-35 disabled:cursor-default focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent'

export default function MessageSearchBar({ query, matchIndex, matchCount, onQueryChange, onPrevious, onNext, onClose }: Props) {
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  return (
    <div
      className="sticky top-[10px] z-[8] flex items-center gap-1.5 w-[min(420px,calc(100%-20px))] min-h-[var(--ui-control-standard)] mx-auto mb-2 py-1 pr-1.5 pl-2.5 text-text-dim bg-bg-panel border border-border rounded-none shadow-[0_4px_16px_rgba(0,0,0,0.12)] focus-within:border-accent focus-within:shadow-[0_0_0_3px_var(--accent-soft)] [.layout>.context-panel-body_&]:static [.layout>.context-panel-body_&]:w-full [.layout>.context-panel-body_&]:mx-0 [.layout>.context-panel-body_&]:mb-3 [.layout>.context-panel-body_&]:shadow-none"
      role="search"
      aria-label="搜索当前会话消息"
    >
      <Search size={15} aria-hidden="true" />
      <input
        ref={inputRef}
        value={query}
        onChange={event => onQueryChange(event.target.value)}
        onKeyDown={event => {
          if (event.key === 'Enter') {
            event.preventDefault()
            if (event.shiftKey) onPrevious()
            else onNext()
          }
          if (event.key === 'Escape') {
            event.preventDefault()
            onClose()
          }
        }}
        placeholder="搜索消息"
        aria-label="搜索消息"
        className="min-w-0 flex-1 border-0 outline-none bg-transparent text-text text-[13px] leading-[1.4] font-[family-name:var(--font)] placeholder:text-text-dim"
      />
      <span className="shrink-0 min-w-[42px] text-right text-sm" aria-live="polite">
        {query.trim() && matchCount > 0 ? `${matchIndex + 1}/${matchCount}` : query.trim() ? '无结果' : ''}
      </span>
      <button type="button" className={navButton} onClick={onPrevious} disabled={matchCount === 0} aria-label="上一个搜索结果" title="上一个结果（Shift+Enter）">
        <ChevronUp size={15} />
      </button>
      <button type="button" className={navButton} onClick={onNext} disabled={matchCount === 0} aria-label="下一个搜索结果" title="下一个结果（Enter）">
        <ChevronDown size={15} />
      </button>
      <button type="button" className={navButton} onClick={onClose} aria-label="关闭消息搜索" title="关闭（Esc）">
        <X size={15} />
      </button>
    </div>
  )
}
