import { useEffect, useRef } from 'react'
import { ChevronDown, ChevronUp, Search, X } from 'lucide-react'

interface Props {
  query: string
  matchIndex: number
  matchCount: number
  onQueryChange: (query: string) => void
  onPrevious: () => void
  onNext: () => void
  onClose: () => void
}

export default function MessageSearchBar({ query, matchIndex, matchCount, onQueryChange, onPrevious, onNext, onClose }: Props) {
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  return (
    <div className="message-search-bar" role="search" aria-label="搜索当前会话消息">
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
      />
      <span className="message-search-count" aria-live="polite">
        {query.trim() && matchCount > 0 ? `${matchIndex + 1}/${matchCount}` : query.trim() ? '无结果' : ''}
      </span>
      <button type="button" onClick={onPrevious} disabled={matchCount === 0} aria-label="上一个搜索结果" title="上一个结果（Shift+Enter）">
        <ChevronUp size={15} />
      </button>
      <button type="button" onClick={onNext} disabled={matchCount === 0} aria-label="下一个搜索结果" title="下一个结果（Enter）">
        <ChevronDown size={15} />
      </button>
      <button type="button" onClick={onClose} aria-label="关闭消息搜索" title="关闭（Esc）">
        <X size={15} />
      </button>
    </div>
  )
}