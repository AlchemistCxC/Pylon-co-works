import { useMemo, useRef, useState } from 'react'
import { useStore } from '../../store'
import { GLOBAL_PRESETS } from '../../presets'
import { THEME_DEFAULTS } from '../../themeFieldDefs'
import SettingsPreview from '../SettingsPreview'
import type { ThemeSettings } from '../../store'
import { themeToCssVars } from './templateThemeVars.ts'
import { createPresetBundle, presetCoverage, type PresetApplyResult } from '../../domains/theme/presetBundle.ts'
import { normalizeCustomPresetId } from '../../customPresets.ts'

/**
 * TemplateLibrary — 官方/自定义模板库（W2-14，F3-C/T2）。
 *
 * 官方预设 + 用户自定义两分区；预览 = 对 delta 计算 { ...THEME_DEFAULTS, ...delta }
 * 的内存态 cssVars 注入预览容器局部 style（复用 SettingsPreview 渲染——不触全局 store，
 * hover 不写 store）；点击才应用（setGlobalPreset / applyCustomPreset）；「恢复此模板
 * 默认」重应用当前模板 delta（清手调字段）。
 */

export default function TemplateLibrary({ onApply, onRestore, onCustomApply }: {
  onApply: (presetName: string) => void | Promise<void>
  onRestore: (presetName: string) => void | Promise<void>
  onCustomApply?: (presetId: string) => Promise<PresetApplyResult>
}) {
  const customPresets = useStore(s => s.customPresets)
  const applyCustomPreset = useStore(s => s.applyCustomPreset)
  const [applyingId, setApplyingId] = useState<string | null>(null)
  const applyingRef = useRef<string | null>(null)
  const [applyFeedback, setApplyFeedback] = useState<{ kind: 'success' | 'error'; message: string } | null>(null)
  const official = useMemo(() => GLOBAL_PRESETS.map(preset => ({
    id: `official:${preset.name}`,
    name: preset.name,
    label: preset.label,
    theme: { ...THEME_DEFAULTS, ...preset.theme } as Partial<ThemeSettings>,
    bundle: createPresetBundle({ id: `official:${preset.name}`, name: preset.label, now: 0, theme: preset.theme as unknown as import('../../domains/theme/presetBundle.ts').PresetJsonValue }),
  })), [])

  const custom = useMemo(() => customPresets.map(preset => ({
    id: `custom:${preset.id}`,
    name: preset.id,
    label: preset.name,
    theme: { ...THEME_DEFAULTS, ...preset.theme } as Partial<ThemeSettings>,
    bundle: preset.bundle,
  })), [customPresets])

  const applyTemplate = async (template: { id: string; name: string }) => {
    if (applyingRef.current) return
    const custom = template.id.startsWith('custom:')
    applyingRef.current = template.id
    setApplyingId(template.id)
    setApplyFeedback(null)
    try {
      if (custom) {
        const result = await (onCustomApply
          ? onCustomApply(normalizeCustomPresetId(template.name))
          : applyCustomPreset(normalizeCustomPresetId(template.name)))
        if (result.status === 'applied') {
          setApplyFeedback({
            kind: 'success',
            message: result.unavailable && result.unavailable.length > 0
              ? `自定义预设已应用（不可用提供者：${result.unavailable.join('、')}）`
              : '自定义预设已应用',
          })
        } else {
          setApplyFeedback({ kind: 'error', message: `自定义预设应用失败（${result.failedProvider}）：${result.message}` })
        }
      } else {
        await onApply(template.name)
        setApplyFeedback({ kind: 'success', message: '预设已应用' })
      }
    } catch (error) {
      setApplyFeedback({ kind: 'error', message: error instanceof Error ? error.message : String(error) })
    } finally {
      applyingRef.current = null
      setApplyingId(null)
    }
  }

  const renderCard = (template: { id: string; name: string; label: string; theme: Partial<ThemeSettings>; bundle?: import('../../domains/theme/presetBundle.ts').PresetBundleV2 }) => (
    <div
      key={template.id}
      className="template-card"
    >
      <div className="template-preview" style={themeToCssVars(template.theme)}>
        <SettingsPreview zone="global" />
      </div>
      <div className="template-actions">
        <button type="button" className="template-apply" disabled={applyingId !== null} aria-busy={applyingId === template.id || undefined} onClick={() => { void applyTemplate(template) }}>
          {applyingId === template.id ? '应用中…' : '应用'}
        </button>
        {!template.id.startsWith('custom:') && (
          <button type="button" className="template-restore" onClick={() => onRestore(template.name)}>恢复此模板默认</button>
        )}
      </div>
      <div className="template-label">{template.label}</div>
      <div className="template-coverage" aria-label="预设覆盖范围">
        {presetCoverage(template.bundle).map(item => <span key={item.id}
          className={`is-${item.state}`}
          title={item.policy ? `${item.policy === 'complete' ? '完整' : '局部'}覆盖：显式 ${item.explicit}，默认 ${item.defaulted}，不可用 ${item.unavailable}` : undefined}>
          <i aria-hidden="true" />{item.label}{item.state === 'missing'
            ? ' · 未记录'
            : item.state === 'unavailable'
              ? ` · 不可用 ${item.unavailable}`
              : item.defaulted > 0
                ? ` · ${item.explicit} 显式 / ${item.defaulted} 默认`
                : ` · ${item.explicit} 显式`}{item.policy === 'partial' ? ' · 局部' : ''}
        </span>)}
      </div>
    </div>
  )

  return (
    <div className="template-library">
      {applyFeedback && <div className={`template-apply-feedback is-${applyFeedback.kind}`} role={applyFeedback.kind === 'error' ? 'alert' : 'status'} aria-live="polite">{applyFeedback.message}</div>}
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
