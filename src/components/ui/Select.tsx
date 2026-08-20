import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown } from 'lucide-react'

export interface SelectOption {
  value: string
  label: string
  description?: string
  disabled?: boolean
}

interface SelectProps {
  value: string
  options: readonly SelectOption[]
  onChange(value: string): void
  id?: string
  className?: string
  disabled?: boolean
  ariaLabel?: string
}

function enabledIndex(options: readonly SelectOption[], from: number, direction: -1 | 1): number {
  if (options.length === 0) return -1
  for (let step = 1; step <= options.length; step += 1) {
    const index = (from + step * direction + options.length) % options.length
    if (!options[index]?.disabled) return index
  }
  return -1
}

/** 无状态值语义的可访问 Select；弹层与滚动容器解耦，业务状态仍由调用方所有。 */
export default function Select({ value, options, onChange, id, className = '', disabled, ariaLabel }: SelectProps) {
  const generatedId = useId().replace(/:/g, '-')
  const triggerId = id ?? `pylon-select-${generatedId}`
  const listboxId = `${triggerId}-listbox`
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const optionRefs = useRef(new Map<number, HTMLDivElement>())
  const selectedIndex = Math.max(0, options.findIndex(option => option.value === value))
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(selectedIndex)
  const [position, setPosition] = useState({ left: 0, top: 0, width: 0, maxHeight: 280 })
  const selected = options.find(option => option.value === value) ?? options[0]

  const placeMenu = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect()
    if (!rect) return
    const roomBelow = window.innerHeight - rect.bottom - 12
    const roomAbove = rect.top - 12
    const openAbove = roomBelow < 180 && roomAbove > roomBelow
    const maxHeight = Math.max(96, Math.min(320, openAbove ? roomAbove : roomBelow))
    setPosition({
      left: Math.max(8, Math.min(rect.left, window.innerWidth - Math.max(rect.width, 180) - 8)),
      top: openAbove ? Math.max(8, rect.top - maxHeight - 4) : rect.bottom + 4,
      width: Math.max(rect.width, 180),
      maxHeight,
    })
  }, [])

  const openMenu = () => {
    if (disabled || options.length === 0) return
    const next = options[selectedIndex]?.disabled ? enabledIndex(options, selectedIndex, 1) : selectedIndex
    setActiveIndex(next)
    placeMenu()
    setOpen(true)
  }

  const choose = (index: number) => {
    const option = options[index]
    if (!option || option.disabled) return
    onChange(option.value)
    setOpen(false)
    requestAnimationFrame(() => triggerRef.current?.focus())
  }

  useEffect(() => {
    if (!open) return
    const dismiss = (event: MouseEvent) => {
      const target = event.target as Node
      if (!triggerRef.current?.contains(target) && !menuRef.current?.contains(target)) setOpen(false)
    }
    const reposition = () => placeMenu()
    document.addEventListener('mousedown', dismiss)
    window.addEventListener('resize', reposition)
    window.addEventListener('scroll', reposition, true)
    return () => {
      document.removeEventListener('mousedown', dismiss)
      window.removeEventListener('resize', reposition)
      window.removeEventListener('scroll', reposition, true)
    }
  }, [open, placeMenu])

  useEffect(() => {
    if (open) optionRefs.current.get(activeIndex)?.scrollIntoView?.({ block: 'nearest' })
  }, [activeIndex, open])

  const activeOptionId = useMemo(() => `${listboxId}-option-${Math.max(0, activeIndex)}`, [activeIndex, listboxId])

  return <span className={`pylon-select ${className}`.trim()}>
    <button
      ref={triggerRef}
      id={triggerId}
      type="button"
      className="pylon-select-trigger"
      role="combobox"
      aria-label={ariaLabel}
      aria-expanded={open}
      aria-controls={listboxId}
      aria-activedescendant={open && activeIndex >= 0 ? activeOptionId : undefined}
      aria-haspopup="listbox"
      disabled={disabled}
      onClick={() => open ? setOpen(false) : openMenu()}
      onKeyDown={event => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault()
          if (!open) openMenu()
          else setActiveIndex(current => enabledIndex(options, current, event.key === 'ArrowDown' ? 1 : -1))
        } else if (event.key === 'Home' || event.key === 'End') {
          if (!open) return
          event.preventDefault()
          const start = event.key === 'Home' ? -1 : 0
          setActiveIndex(enabledIndex(options, start, event.key === 'Home' ? 1 : -1))
        } else if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          if (open) choose(activeIndex)
          else openMenu()
        } else if (event.key === 'Escape' && open) {
          event.preventDefault()
          setOpen(false)
        } else if (event.key === 'Tab') {
          setOpen(false)
        } else if (event.key.length === 1 && /\S/.test(event.key)) {
          const key = event.key.toLocaleLowerCase()
          const match = options.findIndex(option => !option.disabled && option.label.toLocaleLowerCase().startsWith(key))
          if (match >= 0) {
            event.preventDefault()
            if (!open) openMenu()
            setActiveIndex(match)
          }
        }
      }}
    >
      <span className="pylon-select-value">{selected?.label ?? '—'}</span>
      <ChevronDown size={14} aria-hidden="true" />
    </button>
    {open && createPortal(<div
      ref={menuRef}
      id={listboxId}
      className="pylon-select-listbox"
      role="listbox"
      aria-labelledby={ariaLabel ? undefined : triggerId}
      aria-label={ariaLabel}
      style={{ left: position.left, top: position.top, width: position.width, maxHeight: position.maxHeight }}
    >
      {options.map((option, index) => <div
        key={option.value}
        ref={node => { if (node) optionRefs.current.set(index, node); else optionRefs.current.delete(index) }}
        id={`${listboxId}-option-${index}`}
        className={`pylon-select-option${index === activeIndex ? ' active' : ''}`}
        role="option"
        aria-selected={option.value === value}
        aria-disabled={option.disabled || undefined}
        onMouseDown={event => { event.preventDefault(); choose(index) }}
        onMouseEnter={() => { if (!option.disabled) setActiveIndex(index) }}
      >
        <span className="pylon-select-option-copy"><span>{option.label}</span>{option.description && <small>{option.description}</small>}</span>
        {option.value === value && <Check size={14} aria-hidden="true" />}
      </div>)}
    </div>, document.body)}
  </span>
}
