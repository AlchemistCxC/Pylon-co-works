import { useMemo, useState } from 'react'
import { useSettingsChromeStore } from '../../domains/appearance/settingsChromeStore.ts'
import { useRightRailStore } from '../../domains/workspace/layoutRailsStore.ts'
import { pulseSettingsAnchor } from '../../utils/anchorPulse.ts'
import { SETTINGS_DOMAINS, type SettingsDomainId, type SettingsSearchItem, type SettingsSectionId } from './settingsDomains'
/**
 * useSettingsSearchNavigation — 设置速搜的定位态与跳转（A-V3 拆分自 Settings.tsx，
 * 逻辑逐字随迁）：命令面板开合、索引缓存（面板打开或 catalog 热更时失效）、
 * navigateToField 的三路跳转（右栏面板/插件页/renderer 路由）+ 锚点滚动与脉冲。
 * navigate 由调用方注入（sheet 状态 patch 绑定）。
 */
export function useSettingsSearchNavigation(options: {
  navigate: (partial: {
    domain?: SettingsDomainId
    section?: SettingsSectionId
    pluginPageId?: string | null
    rendererCategoryId?: string | null
  }) => void
  activeDomain: SettingsDomainId
  rendererRegistryRevision: number
  searchItems: readonly SettingsSearchItem[]
  onRendererRoute: (route: NonNullable<SettingsSearchItem['rendererRoute']>) => void
  onSearchQuery: (label: string) => void
}) {
  const { navigate, activeDomain, rendererRegistryRevision, searchItems, onRendererRoute, onSearchQuery } = options
  const density = useSettingsChromeStore(s => s.density)
  const setDensity = useSettingsChromeStore(s => s.setDensity)

  // O-3：速搜定位态
  const [quickSearchOpen, setQuickSearchOpen] = useState(false)
  // B2 边界修复：面板打开或 Renderer catalog 热更新时重建索引。
  // 不能只依赖 quickSearchOpen，否则插件热装卸后的字段要重新打开命令面板才可搜。
  const quickSearchItems = useMemo(() => {
    // 显式引用依赖项：它们是缓存失效信号（B2），非数据来源——抑制 exhaustive-deps
    void quickSearchOpen
    void rendererRegistryRevision
    return searchItems
  }, [quickSearchOpen, rendererRegistryRevision, searchItems])

  // F1 边界修复：section → 所属 domain 反查（SETTINGS_DOMAINS 单一真值派生）
  const domainOfSection = (section: string): SettingsDomainId | undefined =>
    SETTINGS_DOMAINS.find(d => (d.sections as readonly string[]).includes(section))?.id
  const jumpToSection = (section: SettingsSectionId) => {
    const domain = domainOfSection(section)
    // #154 阶段 4：跨域跳转由 codec 归一（normalizeSettingsSheetState → normalizeSettingsIntent），
    // 这里直接写目标 section 与所属 domain；二级折叠展开态归左栏导航组件自持。
    navigate({ section, domain: domain ?? activeDomain, pluginPageId: null })
  }
  const navigateToField = (item: SettingsSearchItem) => {
    if (item.contextPanelId) {
      navigate({ domain: 'appearance', section: 'right', pluginPageId: null })
      useRightRailStore.getState().setActivePanel(item.contextPanelId)
      useRightRailStore.getState().setCollapsed(false)
      if (item.anchor) requestAnimationFrame(() => document.querySelector(`[data-search-anchor="${CSS.escape(item.anchor!)}"]`)?.scrollIntoView({ block: 'center' }))
      return
    }
    if (item.pluginPageId) {
      navigate({ domain: 'plugins', section: 'pluginManager', pluginPageId: item.pluginPageId })
      if (item.anchor) requestAnimationFrame(() => document.querySelector(`[data-search-anchor="${CSS.escape(item.anchor!)}"]`)?.scrollIntoView({ block: 'center' }))
      return
    }
    if (item.rendererRoute) {
      navigate({ rendererCategoryId: item.rendererRoute.categoryId })
      onRendererRoute(item.rendererRoute)
      onSearchQuery(item.label)
    }
    jumpToSection(item.section)
    if (density !== 'all') setDensity('all')  // D2-A：advanced 命中自动切全部档
    requestAnimationFrame(() => {
      // B3 边界修复：优先唯一锚定位（重名字段如多个「背景图」不再误跳第一处）
      let target: Element | null = null
      if (item.anchor) target = document.querySelector(`[data-search-anchor="${CSS.escape(item.anchor)}"]`)
      if (!target) {
        // 链B entry 无字段级锚——回退到组标题文本匹配
        target = [...document.querySelectorAll('.set-group-title, .renderer-settings-group-heading h3')]
          .find(el => el.textContent?.includes(item.label)) ?? null
      }
      target?.scrollIntoView({ block: 'center', behavior: 'smooth' })
      const group = target?.closest('[data-group-anchor], .renderer-settings-group, .set-group')
      if (group instanceof HTMLElement) pulseSettingsAnchor(group)
    })
  }

  return { quickSearchOpen, setQuickSearchOpen, quickSearchItems, navigateToField }
}
