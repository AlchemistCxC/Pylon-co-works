import { useState } from 'react'
import type { WorkspaceViewProps } from '../workspace-sheets/workspaceTypes.ts'
import { normalizeSettingsSheetState, type SettingsSheetState } from '../workspace-sheets/settingsSheetState.ts'
import {
  SETTINGS_DOMAINS,
  SETTINGS_DOMAIN_BY_ID,
  SETTINGS_DOMAIN_MENU_META,
  SETTINGS_SECTION_LABELS,
  HOSTED_PLUGIN_MANAGER_PAGE_ID,
  sectionZone,
  type SettingsDomainId,
  type SettingsSectionId,
} from '../settingsDomains.ts'
import { GROUP_ORDER } from '../themeFieldDefs'
import { useStore } from '../store'
import { useWorkspaceStore } from '../domains/workspace/workspaceStore.ts'
import { readPinned, writePinned, PINNED_LIMIT, safeStorage } from '../components/settings/settingsChromeState.ts'
import { resetThemeForActiveInterfaceMode } from '../application/transactions/activateInterfaceMode.ts'
import { useSettingsContributionCatalog } from '../components/settings/useSettingsContributionCatalog.ts'
import { pulseSettingsAnchor } from '../utils/anchorPulse.ts'

/**
 * Settings Sheet 左栏导航（#154 阶段 4：一二级同栏分层）。
 *
 * 上半：4 个一级域（大字号 + 字形）——旧覆盖层里域切换只存在于标题栏菜单，
 * 现在域与分区同栏；下半：当前域分区（小字号缩进，沿用分区/子组/置顶/插件页交互）；
 * 页脚：重置主题两段式确认（#116 子项 9 语义原样迁入）。
 * 几何（宽度/分割线/折叠）归布局层的 `.sidebar`，本组件只提供内容。
 */
export default function SettingsSheetSidebar({ sheet, state }: WorkspaceViewProps<SettingsSheetState>) {
  const { pluginSettingsPages } = useSettingsContributionCatalog()
  const storage = safeStorage()
  // K-2：二级折叠导航展开态（session 内 UI 态；打开设置默认收起）
  const [navExpanded, setNavExpanded] = useState<ReadonlySet<string>>(new Set())
  const toggleNavSection = (section: string) => {
    setNavExpanded(prev => {
      const next = new Set(prev)
      if (next.has(section)) next.delete(section)
      else next.add(section)
      return next
    })
  }
  // K-4：收藏置顶（拍板 D4-A hover 星标；上限 PINNED_LIMIT=3）
  const [pinned, setPinned] = useState<readonly string[]>(() => readPinned(k => storage.get(k)))
  const togglePinned = (section: string) => {
    const next = pinned.includes(section)
      ? pinned.filter(id => id !== section)
      : [...pinned, section].slice(-PINNED_LIMIT)
    setPinned(next)
    writePinned(next, (key, v) => storage.set(key, v))
  }
  // #116 子项 9：重置主题两段式确认（原 Settings.tsx 页脚语义整体迁入）
  const [confirmResetTheme, setConfirmResetTheme] = useState(false)
  const reset = () => { resetThemeForActiveInterfaceMode() }
  // 该区有自定义改动（dirty）时导航按钮带小圆点（store 真值，与字段编辑同步）
  const custom = useStore(s => s.custom)

  const navigate = (partial: { domain?: SettingsDomainId; section?: SettingsSectionId; pluginPageId?: string | null; rendererCategoryId?: string | null }) => {
    useWorkspaceStore.getState().patchSheetState(sheet.id, normalizeSettingsSheetState({ ...state, ...partial }) as unknown as Record<string, unknown>)
  }
  const activeDomainConfig = SETTINGS_DOMAIN_BY_ID[state.domain]
  // section → 二级项（组标题）。链A 从 GROUP_ORDER[zone] 派生；无 zone 或 <2 组返回空（不显示箭头）
  const navGroupsFor = (section: SettingsSectionId): readonly { readonly id: string; readonly label: string }[] => {
    if (section === 'renderers') return []
    const zone = sectionZone(section)
    if (!zone) return []
    const groups = (GROUP_ORDER[zone] ?? []).flatMap(block => [...block.groups.map(g => g.title)])
    return groups.length >= 2 ? groups.map(title => ({ id: title, label: title })) : []
  }

  return (
    <aside className="sidebar settings-sheet-nav">
      <nav className="settings-sheet-nav-domains" aria-label="设置域">
        {SETTINGS_DOMAINS.map(domain => (
          <button
            type="button"
            key={domain.id}
            className={`settings-sheet-nav-domain${state.domain === domain.id ? ' active' : ''}`}
            aria-current={state.domain === domain.id ? 'true' : undefined}
            onClick={() => navigate({ domain: domain.id, section: domain.sections[0] ?? 'global', pluginPageId: null })}
          >
            <span className="settings-sheet-nav-domain-glyph" aria-hidden="true">{SETTINGS_DOMAIN_MENU_META[domain.id].glyph}</span>
            <span className="settings-sheet-nav-domain-text">
              <strong>{domain.label}</strong>
              <small>{SETTINGS_DOMAIN_MENU_META[domain.id].description}</small>
            </span>
          </button>
        ))}
      </nav>

      <div className="settings-sheet-nav-sections">
        <div className="settings-nav-group settings-nav-sections">
          {pinned.length > 0 && (
            <>
              <div className="settings-nav-label">常用</div>
              {pinned.map(section => (
                <button type="button" key={`pin-${section}`} className="set-nav-btn pinned"
                  onClick={() => navigate({ section: section as SettingsSectionId, pluginPageId: null })}>
                  <span className="settings-nav-pin-star" aria-hidden="true">★</span>
                  {SETTINGS_SECTION_LABELS[section as SettingsSectionId]}
                </button>
              ))}
            </>
          )}
          <div className="settings-nav-label">{activeDomainConfig.label} 分区</div>
          {activeDomainConfig.sections.map(section => {
            const zone = sectionZone(section)
            const subGroups = navGroupsFor(section)
            const expanded = navExpanded.has(section)
            const label = SETTINGS_SECTION_LABELS[section]
            const hasSub = subGroups.length > 0
            return (
              <div key={section} className="settings-nav-section-block">
                <div className="settings-nav-section-row">
                  <button type="button"
                    className={`set-nav-btn ${state.pluginPageId == null && state.section === section ? 'active' : ''}${zone && custom[zone] ? ' dirty' : ''}`}
                    aria-expanded={hasSub ? expanded : undefined}
                    onClick={() => {
                      navigate({ section, pluginPageId: null })
                      if (hasSub) toggleNavSection(section)
                    }}
                    title={zone && custom[zone] ? '该区有未保存的自定义改动' : undefined}>
                    {hasSub && <span className="settings-nav-caret" aria-hidden="true">{expanded ? '▾' : '▸'}</span>}
                    {label}
                  </button>
                  <button type="button" className={`settings-nav-pin${pinned.includes(section) ? ' pinned' : ''}`}
                    aria-label={pinned.includes(section) ? `取消置顶 ${label}` : `置顶 ${label}`}
                    aria-pressed={pinned.includes(section)}
                    onClick={e => { e.stopPropagation(); togglePinned(section) }}>★</button>
                </div>
                {hasSub && expanded && (
                  <div className="settings-nav-subgroups">
                    {subGroups.map(group => (
                      <button type="button" key={group.id}
                        className={`set-nav-btn subgroup${section === 'renderers' && state.rendererCategoryId === group.id ? ' active' : ''}`}
                        onClick={e => {
                          e.stopPropagation()
                          if (section === 'renderers') {
                            navigate({ rendererCategoryId: group.id })
                            return
                          }
                          navigate({ section, pluginPageId: null })
                          // 锚点滚动：主区渲染后按组标题定位（下一帧；两树同文档，querySelector 可达）
                          requestAnimationFrame(() => {
                            const target = document.querySelector(`[data-group-anchor="${CSS.escape(group.label)}"]`)
                            target?.scrollIntoView({ block: 'start', behavior: 'smooth' })
                            // O-2：高亮脉冲 1.2s（prefers-reduced-motion 时 CSS 端自动禁用动画）
                            pulseSettingsAnchor(target)
                          })
                        }}>
                        {group.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
          {state.domain === 'plugins' && pluginSettingsPages
            // #274：宿主「插件管理」分区在贡献存在时已直接渲染该页（Settings.tsx P53
            // 重定向），再列独立条目即同一页面双入口——托管的这条不再单列。
            .filter(entry => entry.contributionId !== HOSTED_PLUGIN_MANAGER_PAGE_ID)
            .map(entry => (
              <button type="button" key={entry.contributionId}
                className={`set-nav-btn plugin-page ${state.pluginPageId === entry.contributionId ? 'active' : ''}`}
                onClick={() => navigate({ pluginPageId: entry.contributionId })}
                title={entry.value.description}>
                <span>{entry.value.label}</span>
                <small>{entry.ownerPluginId}</small>
              </button>
            ))}
        </div>
      </div>

      <div className="settings-sheet-nav-footer">
        {confirmResetTheme ? (
          <div className="set-confirm" role="alertdialog" aria-label="确认重置主题">
            <p className="set-confirm-text">重置主题会把当前外观（含手动改动）恢复为本界面模式的默认值，且不可撤销。</p>
            <div className="set-confirm-actions">
              <button type="button" className="ps-btn sm danger"
                onClick={() => { setConfirmResetTheme(false); reset() }}>确认重置</button>
              <button type="button" className="ps-btn sm"
                onClick={() => setConfirmResetTheme(false)}>取消</button>
            </div>
          </div>
        ) : (
          <button type="button" className="set-nav-btn reset" onClick={() => setConfirmResetTheme(true)}>重置主题</button>
        )}
      </div>
    </aside>
  )
}
