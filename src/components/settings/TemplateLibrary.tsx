import { useMemo } from 'react'
import { useStore } from '../../store'
import { GLOBAL_PRESETS } from '../../presets'
import { THEME_DEFAULTS } from '../../themeFieldDefs'
import SettingsPreview from '../SettingsPreview'
import type { ThemeSettings } from '../../store'
import { themeToCssVars } from './templateThemeVars.ts'

/**
 * TemplateLibrary — 官方/自定义模板库（W2-14，F3-C/T2）。
 *
 * 官方预设 + 用户自定义两分区；预览 = 对 delta 计算 { ...THEME_DEFAULTS, ...delta }
 * 的内存态 cssVars 注入预览容器局部 style（复用 SettingsPreview 渲染——不触全局 store，
 * hover 不写 store）；点击才应用（setGlobalPreset / applyCustomPreset）；「恢复此模板
 * 默认」重应用当前模板 delta（清手调字段）。
 */

export default function TemplateLibrary({ onApply, onRestore }: {
  onApply: (presetName: string) => void
  onRestore: (presetName: string) => void
}) {
  const customPresets = useStore(s => s.customPresets)
  const applyCustomPreset = useStore(s => s.applyCustomPreset)
  const official = useMemo(() => GLOBAL_PRESETS.map(preset => ({
    id: `official:${preset.name}`,
    name: preset.name,
    label: preset.label,
    theme: { ...THEME_DEFAULTS, ...preset.theme } as Partial<ThemeSettings>,
  })), [])

  const custom = useMemo(() => customPresets.map(preset => ({
    id: `custom:${preset.id}`,
    name: preset.id,
    label: preset.name,
    theme: { ...THEME_DEFAULTS, ...preset.theme } as Partial<ThemeSettings>,
  })), [customPresets])

  const renderCard = (template: { id: string; name: string; label: string; theme: Partial<ThemeSettings> }) => (
    <div
      key={template.id}
      className="template-card"
    >
      <div className="template-preview" style={themeToCssVars(template.theme)}>
        <SettingsPreview zone="global" />
      </div>
      <div className="template-actions">
        <button type="button" className="template-apply" onClick={() => {
          if (template.id.startsWith('custom:')) applyCustomPreset(template.name)
          else onApply(template.name)
        }}>应用</button>
        {!template.id.startsWith('custom:') && (
          <button type="button" className="template-restore" onClick={() => onRestore(template.name)}>恢复此模板默认</button>
        )}
      </div>
      <div className="template-label">{template.label}</div>
    </div>
  )

  return (
    <div className="template-library">
      <div className="template-section">
        <div className="file-section-title">官方模板</div>
        <div className="template-grid">{official.map(renderCard)}</div>
      </div>
      <div className="template-section">
        <div className="file-section-title">自定义模板</div>
        {custom.length === 0 ? (
          <p className="file-section-hint">还没有自定义模板</p>
        ) : (
          <div className="template-grid">{custom.map(renderCard)}</div>
        )}
      </div>
    </div>
  )
}
