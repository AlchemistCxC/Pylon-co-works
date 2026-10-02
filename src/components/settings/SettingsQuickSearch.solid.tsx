/** @jsxImportSource solid-js */
import { createEffect, createMemo, createSignal, For, onCleanup, Show, untrack } from 'solid-js'
import type { SettingsSearchItem } from './settingsDomains.ts'

/**
 * O-3 速搜定位态（设计书 07 §4.3，拍板 D2-A）：
 * #515：cmdk（React 生态）的手写最小 Solid 等价（指南 §3，不新增依赖）——
 * 候选=全量字段索引，显示「域›区›组›字段」路径；advanced 命中带「高级」徽标
 * （跳转时由调用方自动切 all 档）。过滤 = value 串大小写不敏感子串匹配、不匹配项
 * 从 DOM 移除、全空显示 Empty；键盘 ↑↓ 循环选区、Enter 选中、Esc/'/'（全局）、
 * 遮罩点击关闭；DOM 携带 cmdk 属性词汇（[cmdk-input]/[cmdk-list]/[cmdk-group]/
 * [cmdk-group-heading]/[cmdk-empty]/[cmdk-item] + data-selected/aria-selected）。
 * 模板：SheetLauncher 的 Command.Dialog 分组结构（同款手写等价先例）。
 */
export default function SettingsQuickSearch(props: {
  open: boolean
  items: readonly SettingsSearchItem[]
  onNavigate: (item: SettingsSearchItem) => void
  onOpenChange: (open: boolean) => void
}) {
  const [query, setQuery] = createSignal('')
  const [selectedKey, setSelectedKey] = createSignal<string | null>(null)
  let inputElement: HTMLInputElement | undefined

  const keyOf = (item: SettingsSearchItem): string => `${item.path}.${item.label}`
  // SheetLauncher 惯例：value 拼接搜索词（路径+字段名），让匹配吃满上下文
  const visibleItems = createMemo(() => {
    const needle = query().trim().toLowerCase()
    if (!needle) return props.items
    return props.items.filter(item => `${item.path} ${item.label}`.toLowerCase().includes(needle))
  })

  // 查询变化后选区归首项（cmdk 语义）
  createEffect(() => {
    void query()
    untrack(() => setSelectedKey(visibleItems()[0] ? keyOf(visibleItems()[0]!) : null))
  })

  // 打开时聚焦输入框并清空上次查询（cmdk Dialog 卸载即重置的语义；组件实例常驻，
  // 状态必须在开面板时手动复位）。
  createEffect(() => {
    if (!props.open) return
    untrack(() => {
      setQuery('')
      setSelectedKey(visibleItems()[0] ? keyOf(visibleItems()[0]!) : null)
      inputElement?.focus()
    })
  })

  // 全局键（window 级 keydown）：'/' 呼出（输入态除外）、Esc 关闭
  createEffect(() => {
    const isOpen = props.open
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      const typing = Boolean(target) && (target!.tagName === 'INPUT' || target!.tagName === 'TEXTAREA')
      if (event.key === '/' && !isOpen && !typing) {
        event.preventDefault()
        props.onOpenChange(true)
      }
      if (event.key === 'Escape' && isOpen) props.onOpenChange(false)
    }
    window.addEventListener('keydown', onKey)
    onCleanup(() => window.removeEventListener('keydown', onKey))
  })

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const items = visibleItems()
      if (items.length === 0) return
      const current = items.findIndex(item => keyOf(item) === selectedKey())
      const next = event.key === 'ArrowDown'
        ? (current < 0 ? 0 : (current + 1) % items.length)
        : (current <= 0 ? items.length - 1 : current - 1)
      setSelectedKey(keyOf(items[next]!))
    } else if (event.key === 'Enter') {
      event.preventDefault()
      const item = visibleItems().find(candidate => keyOf(candidate) === selectedKey())
      if (item) {
        props.onNavigate(item)
        props.onOpenChange(false)
      }
    }
  }

  const selectedAttr = (item: SettingsSearchItem) => selectedKey() === keyOf(item)

  return (
    <Show when={props.open}>
      <div class="settings-quicksearch-overlay" onClick={event => { if (event.target === event.currentTarget) props.onOpenChange(false) }}>
        <div class="settings-quicksearch-dialog" role="dialog" aria-modal="true" aria-label="搜索设置项">
          <div class="sheet-launcher-input-row">
            <span aria-hidden="true">›</span>
            <input
              ref={element => { inputElement = element }}
              cmdk-input=""
              placeholder="搜索设置项…（字段名或组名）"
              value={query()}
              onInput={event => setQuery(event.currentTarget.value)}
              onKeyDown={onKeyDown}
            />
            <kbd>Esc</kbd>
          </div>
          <div class="sheet-launcher-list" cmdk-list="" role="listbox" aria-label="搜索设置项">
            <Show when={visibleItems().length === 0}>
              <div class="sheet-launcher-empty" cmdk-empty="">没有匹配项</div>
            </Show>
            <div cmdk-group="">
              <div cmdk-group-heading="">全部设置</div>
              <For each={visibleItems()}>{item => (
                <div
                  cmdk-item=""
                  role="option"
                  aria-selected={selectedAttr(item)}
                  data-selected={selectedAttr(item) ? 'true' : undefined}
                  onClick={() => {
                    props.onNavigate(item)
                    props.onOpenChange(false)
                  }}
                >
                  <span class="settings-quicksearch-path">{item.path} ›</span>
                  <strong>{item.label}</strong>
                  <Show when={item.advanced}><em class="settings-quicksearch-adv">高级</em></Show>
                </div>
              )}</For>
            </div>
          </div>
        </div>
      </div>
    </Show>
  )
}
