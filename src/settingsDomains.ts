/**
 * settingsDomains — Settings 一级信息架构（ISSUE-13 W1，T13-1）。
 *
 * 本模块是导航状态与字段归属的**唯一真值**：每个设置块唯一归属一个
 * domain + section。渲染仍复用 ZoneGroupFields / TemplateLibrary /
 * HistoryRetention 等既有组件（I13 参考方案：config 只描述 IA，不复制
 * 渲染；visual 设计保持现状，W2 再做布局迁移）。
 *
 * - themeFieldDefs 继续作为字段真值（zone/tier/advanced 元数据），本模块
 *   不复制字段定义；字段 → section 通过 SECTION_ZONES（zone → section）
 *   派生，无需逐字段登记。
 * - quick/advanced/expert 不再是一级信息架构：advanced 字段由渲染器
 *   （themeFieldRenderer 的 `<details>`）作域内 disclosure。
 * - section 搜索路径（domain › section）唯一，供搜索命中隐藏字段时显示
 *   所属路径（T13-1）。
 */

import type { ZoneName } from './themeFieldDefs'

export type SettingsDomainId = 'appearance' | 'workspace' | 'agents-connections' | 'plugins'

export type SettingsSectionId =
  | 'templates'
  | 'global'
  | 'sidebar'
  | 'chat'
  | 'renderers'
  | 'cc'
  | 'right'
  | 'window'
  | 'pet'
  | 'history'
  | 'backup'
  | 'agent'
  | 'session'
  | 'gateway'
  | 'pluginManager'

export interface SettingsDomain {
  id: SettingsDomainId
  label: string
  sections: readonly SettingsSectionId[]
}

export const SETTINGS_DOMAINS: readonly SettingsDomain[] = [
  { id: 'appearance', label: '外观', sections: ['templates', 'global', 'sidebar', 'chat', 'renderers', 'cc', 'right'] },
  { id: 'workspace', label: '工作区', sections: ['window', 'pet', 'history', 'backup'] },
  { id: 'agents-connections', label: 'Agent 与连接', sections: ['agent', 'session', 'gateway'] },
  { id: 'plugins', label: '插件', sections: ['pluginManager'] },
] as const

export const SETTINGS_DOMAIN_BY_ID: Record<SettingsDomainId, SettingsDomain> = Object.fromEntries(
  SETTINGS_DOMAINS.map(domain => [domain.id, domain]),
) as Record<SettingsDomainId, SettingsDomain>

export const SETTINGS_SECTION_LABELS: Record<SettingsSectionId, string> = {
  templates: '模板库',
  global: '全局',
  sidebar: '左栏',
  chat: '终端',
  renderers: '渲染器',
  cc: '中控区',
  right: '右栏',
  window: '窗口',
  pet: '宠物',
  history: '历史保留',
  backup: '配置备份',
  agent: 'Agent',
  session: '会话',
  gateway: 'Gateway',
  pluginManager: '插件管理',
}

/** 主题 zone → section（字段归属派生：themeFieldDefs 的 zone 经此归入 section） */
export const SECTION_ZONES: Partial<Record<SettingsSectionId, ZoneName>> = {
  global: 'global',
  sidebar: 'sidebar',
  chat: 'chat',
  cc: 'cc',
  right: 'right',
}

/** section → 所属 domain（config 完整性不变量：唯一归属，见测试） */
export function domainOfSection(section: SettingsSectionId): SettingsDomainId {
  const domain = SETTINGS_DOMAINS.find(d => d.sections.includes(section))
  if (!domain) throw new Error(`设置块 ${section} 未归属任何 domain（config 完整性被破坏）`)
  return domain.id
}

/** section → 主题 zone；非主题 section（templates/window/…）返回 undefined */
export function sectionZone(section: SettingsSectionId): ZoneName | undefined {
  return SECTION_ZONES[section]
}

/** section 搜索路径（T13-1：搜索命中隐藏字段时显示所属路径） */
export function searchPathFor(section: SettingsSectionId): string {
  return `${SETTINGS_DOMAIN_BY_ID[domainOfSection(section)].label} › ${SETTINGS_SECTION_LABELS[section]}`
}

/**
 * S5 Owner 正式化（设计书 v2 §v2.1/v2.2）：section → 归属组件 id。
 * 主题 zone 的 owner 语义升格；renderers section 由渲染器 catalog 自身充当 owner。
 */
export const SECTION_OWNERS = {
  global: 'app-shell',
  sidebar: 'sidebar',
  chat: 'message-stream',
  cc: 'control-center',
  right: 'context-panel',
  renderers: 'renderer-catalog',
} as const satisfies Partial<Record<SettingsSectionId, string>>

/** 页面自有 sections：预设编排与动作面板，归属设置页而非任何组件（设计书 v2 §v2.1）。 */
export const PAGE_OWNED_SECTIONS = ['templates', 'window', 'history', 'backup'] as const satisfies readonly SettingsSectionId[]

export function isPageOwnedSection(section: SettingsSectionId): boolean {
  return (PAGE_OWNED_SECTIONS as readonly string[]).includes(section)
}
