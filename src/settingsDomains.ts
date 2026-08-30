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

import { THEME_FIELD_DEFS, THEME_FIELD_KEYS } from './themeFieldDefs'
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

export interface SettingsIntent {
  readonly domain: SettingsDomainId
  readonly section: SettingsSectionId
  /** Plugin contribution id when the section is not a built-in section. */
  readonly pluginPageId?: string
  readonly agentId?: string
}

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

/** Index Ledger 的窄一级栏使用短标签；完整名称仍用于 title 与无障碍名称。 */
export const SETTINGS_DOMAIN_SHORT_LABELS: Readonly<Record<SettingsDomainId, string>> = {
  appearance: '外观',
  workspace: '工作',
  'agents-connections': 'Agent',
  plugins: '插件',
}

export const SETTINGS_SECTION_LABELS: Record<SettingsSectionId, string> = {
  templates: '模板库',
  global: '全局',
  sidebar: '侧栏',
  chat: '消息流',
  renderers: '渲染器',
  cc: '中控台',
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

const SETTINGS_SECTION_IDS = new Set<SettingsSectionId>(Object.keys(SETTINGS_SECTION_LABELS) as SettingsSectionId[])

/** Historical deep-link aliases kept at the Settings boundary only. */
const LEGACY_SETTINGS_ROUTES: Readonly<Record<string, { domain: SettingsDomainId; section: SettingsSectionId }>> = {
  'renderer/suite': { domain: 'appearance', section: 'renderers' },
  'renderer/catalog': { domain: 'appearance', section: 'renderers' },
  'renderer': { domain: 'appearance', section: 'renderers' },
  'general': { domain: 'appearance', section: 'global' },
  'conversation': { domain: 'appearance', section: 'chat' },
  'terminal': { domain: 'appearance', section: 'cc' },
  'right-panel': { domain: 'appearance', section: 'right' },
  'plugins': { domain: 'plugins', section: 'pluginManager' },
}

/**
 * Normalize settings deep-links/events to the current domain registry.
 * This is intentionally not part of theme persistence migration: navigation
 * compatibility must not change user settings data or its schema version.
 */
export function normalizeSettingsIntent(input: {
  domain?: string | null
  section?: string | null
  agentId?: string | null
} = {}): SettingsIntent {
  const rawDomain = input.domain?.trim() ?? ''
  const rawSection = input.section?.trim() ?? ''
  const route = LEGACY_SETTINGS_ROUTES[rawDomain && rawSection ? `${rawDomain}/${rawSection}` : rawDomain]
    ?? LEGACY_SETTINGS_ROUTES[rawSection]

  if (route) return { ...route, ...(input.agentId ? { agentId: input.agentId } : {}) }

  const section = SETTINGS_SECTION_IDS.has(rawSection as SettingsSectionId)
    ? rawSection as SettingsSectionId
    : 'global'
  // Unknown sections under plugins are contribution ids; preserve them so the
  // plugin host can decide whether the page is still installed.
  const pluginPageId = rawSection && !SETTINGS_SECTION_IDS.has(rawSection as SettingsSectionId) && rawDomain === 'plugins'
    ? rawSection
    : undefined
  const canonicalSection = pluginPageId ? 'pluginManager' : section
  const canonicalDomain = pluginPageId ? 'plugins' : domainOfSection(canonicalSection)
  return {
    domain: canonicalDomain,
    section: canonicalSection,
    ...(pluginPageId ? { pluginPageId } : {}),
    ...(input.agentId ? { agentId: input.agentId } : {}),
  }
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
/**
 * K-2 优化：渲染器 kind id → 中文名（二级导航与设置面板共用）。
 * 只列带 settings 的 kind；未收录的 id 回退显示原 id。
 */
export const RENDERER_KIND_LABELS: Readonly<Record<string, string>> = {
  'content.markdown': 'Markdown 文本',
  'content.text': '纯文本',
  'content.code': '代码块',
  'content.ansi': '终端输出',
  'content.log': '日志',
  'content.terminal': '终端记录',
  'content.diff': '代码差异',
  'content.reasoning': '思考过程',
  'content.redacted-reasoning': '隐藏思考',
  'content.file-reference': '文件引用',
  'content.file-selection': '文件选择',
  'content.document': '文档',
  'content.resource': '资源',
  'content.mcp-resource': 'MCP 资源',
  'content.memory': '记忆条目',
  'content.skill': '技能卡',
  'content.artifact': '产物卡',
  'content.link': '链接',
  'content.search-result': '搜索结果',
  'activity.background-task': '后台任务',
  'activity.process': '进程活动',
  'diagnostic.lsp': 'LSP 诊断',
  decision: '决策请求',
  'system.hook': '钩子事件',
}
/**
 * O-3 速搜定位态：全量字段索引（链A defs + 链B schema entries 派生）。
 * 路径格式与二级导航一致：域 › 区 › 组 › 字段。
 */
export interface SettingsSearchItem {
  readonly path: string          // 「外观 › 消息流 › 字体」
  readonly label: string         // 字段名
  readonly section: SettingsSectionId
  readonly advanced: boolean     // D2-A：advanced 命中带徽标
  readonly kind?: 'chain-a' | 'chain-b' | 'renderer-entry' | 'plugin-page'
  /** B3：唯一 DOM 锚（链A=`field:${key}`；链B entry 无唯一锚时回退文本匹配） */
  readonly anchor?: string
  /** Renderer catalog route; kept optional so theme/plugin search stays stable. */
  readonly rendererRoute?: {
    readonly categoryId: string
    readonly objectKey: string
    readonly groupId: string
    readonly fieldKey: string
  }
  /** Plugin settings page route; page owns its internal fields. */
  readonly pluginPageId?: string
}

export function buildSettingsSearchIndex(
  rendererEntries?: readonly { value: { id: string; label?: string; settings?: unknown } }[],
  pluginPages?: readonly { contributionId: string; value: { label: string; description?: string } }[],
): readonly SettingsSearchItem[] {
  const items: SettingsSearchItem[] = []
  // 链A：THEME_FIELD_DEFS 按 zone 过滤
  for (const key of THEME_FIELD_KEYS) {
    const def: { zone: string; label: string; group?: string; hidden?: boolean; meta?: boolean; advanced?: boolean } = THEME_FIELD_DEFS[key as keyof typeof THEME_FIELD_DEFS] as never
      if (def.hidden || def.meta) continue
      const section = (SECTION_ZONES as Record<string, SettingsSectionId | undefined>)[def.zone]
      if (!section) continue
      const domain = domainOfSection(section)
      items.push({
        path: `${SETTINGS_DOMAIN_BY_ID[domain].label} › ${SETTINGS_SECTION_LABELS[section]}${def.group ? ` › ${def.group}` : ''}`,
        label: def.label,
        section,
        advanced: def.advanced === true,
        kind: 'chain-a',
        anchor: `field:${key}`,
      })
  }
  // 链B：调用方注入的 renderer entries（避免本模块依赖 runtimeServices）
  for (const entry of rendererEntries ?? []) {
    if (!entry.value.settings) continue
    items.push({
      path: '外观 › 渲染器',
      label: entry.value.label ?? entry.value.id,
      section: 'renderers',
      advanced: false,
      kind: 'renderer-entry',
    })
  }
  // Plugin pages own their internal schema, so index the page itself rather
  // than pretending opaque fields have host-side anchors.
  for (const entry of pluginPages ?? []) {
    items.push({
      path: '插件 › 插件管理',
      label: entry.value.label,
      section: 'pluginManager',
      advanced: false,
      kind: 'plugin-page',
      pluginPageId: entry.contributionId,
    })
  }
  return items
}
