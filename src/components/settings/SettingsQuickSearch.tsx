import { useEffect } from 'react'
import { Command } from 'cmdk'
import type { SettingsSearchItem, SettingsSectionId } from '../../settingsDomains.ts'

/**
 * O-3 速搜定位态（设计书 07 §4.3，拍板 D2-A）：
 * cmdk 命令面板——候选=全量字段索引，显示「域›区›组›字段」路径；
 * advanced 命中带「高级」徽标（跳转时由调用方自动切 all 档）。
 * 模板：SheetLauncher 的 Command.Dialog 分组结构。
 */
export default function SettingsQuickSearch(props: {
  open: boolean
  items: readonly SettingsSearchItem[]
  onNavigate: (section: SettingsSectionId, label: string) => void
  onOpenChange: (open: boolean) => void
}) {
  const { open, items, onNavigate, onOpenChange } = props

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      const typing = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')
      if (e.key === '/' && !open && !typing) {
        e.preventDefault()
        onOpenChange(true)
      }
      if (e.key === 'Escape' && open) onOpenChange(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onOpenChange])

  if (!open) return null

  // SheetLauncher 惯例：value 拼接搜索词（路径+字段名），让 cmdk 模糊匹配吃满上下文
  return (
    <div className="settings-quicksearch-overlay" onClick={() => onOpenChange(false)}>
      <Command.Dialog
        open={open}
        onOpenChange={onOpenChange}
        loop
        label="搜索设置项"
        className="settings-quicksearch-dialog"
      >
        <div className="sheet-launcher-input-row">
          <span aria-hidden="true">›</span>
          <Command.Input autoFocus placeholder="搜索设置项…（字段名或组名）" />
          <kbd>Esc</kbd>
        </div>
        <Command.List className="sheet-launcher-list">
          <Command.Empty>没有匹配项</Command.Empty>
          <Command.Group heading="全部设置">
            {items.map(item => (
              <Command.Item
                key={`${item.path}.${item.label}`}
                value={`${item.path} ${item.label}`}
                onSelect={() => {
                  onNavigate(item.section, item.label)
                  onOpenChange(false)
                }}
              >
                <span className="settings-quicksearch-path">{item.path} ›</span>
                <strong>{item.label}</strong>
                {item.advanced && <em className="settings-quicksearch-adv">高级</em>}
              </Command.Item>
            ))}
          </Command.Group>
        </Command.List>
      </Command.Dialog>
    </div>
  )
}
