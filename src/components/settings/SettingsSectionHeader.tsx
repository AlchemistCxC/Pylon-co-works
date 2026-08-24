import {
  isPageOwnedSection,
  SECTION_OWNERS,
  SETTINGS_SECTION_LABELS,
  type SettingsSectionId,
} from '../../settingsDomains.ts'
import Select from '../ui/Select.tsx'
import type { SettingsDensity } from './settingsChromeState.ts'

const DENSITY_LABELS: Readonly<Record<SettingsDensity, string>> = {
  basic: '基础',
  standard: '标准',
  all: '全部',
}

/**
 * Owner 头（施工书 09 §K-1，设计书 07 §4.2）：
 * 内容区顶部显示「正在调哪个部件」。owner id 纯文字起步（拍板 D1-A，图标位留空）。
 * 页面自有/未登记 section 显示「设置页」徽标（PAGE_OWNED_SECTIONS + isPageOwnedSection 派生）。
 * 密度档三选（拍板 D3-A 全局一档）：basic 只显 tier:'basic'；standard 非 advanced；all 全量。
 */
export default function SettingsSectionHeader(props: {
  section: SettingsSectionId
  density: SettingsDensity
  onDensity: (density: SettingsDensity) => void
}) {
  const { section, density, onDensity } = props
  const owner = (section in SECTION_OWNERS)
    ? SECTION_OWNERS[section as keyof typeof SECTION_OWNERS]
    : undefined
  const pageOwned = owner === undefined || isPageOwnedSection(section)

  return (
    <div className="settings-section-header">
      <span className="settings-owner-badge" data-testid="settings-owner-badge"
        data-owner={pageOwned ? undefined : owner}>
        <span className="settings-owner-diamond" aria-hidden="true">◇</span>
        {' '}
        <strong>{SETTINGS_SECTION_LABELS[section]}</strong>
        {pageOwned
          ? <em className="settings-owner-id settings-owner-page">设置页</em>
          : <em className="settings-owner-id">· {owner}</em>}
      </span>
      {/* F3 边界修复：密度档只对含字段的组件 section 有意义，pageOwned 动作面板不显示 */}
      {!pageOwned && (
        <label className="settings-density-label">
          显示详细度
          {/* K-3 优化：原生 select → ui/Select */}
          <span className="settings-density-select">
            <Select
              value={density}
              options={(Object.keys(DENSITY_LABELS) as SettingsDensity[])
                .map(d => ({ value: d, label: DENSITY_LABELS[d] }))}
              onChange={onDensity}
              ariaLabel="显示详细度"
            />
          </span>
        </label>
      )}
    </div>
  )
}
