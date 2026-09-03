import { useSyncExternalStore } from 'react'
import { fontContributionCssVariable } from '../../plugin-runtime/fonts/fontContributionRegistry.ts'
import type { FontRole } from '../../plugin-runtime/fonts/fontContributionTypes.ts'
import { getFontContributionRegistry } from '../../plugin-runtime/runtimeServices.ts'
import Select from '../ui/Select.tsx'
import { resolvePluginSettingOptions } from '../../plugin-runtime/settings/pluginSettingOptionsRegistry.ts'
import type { RegistryEntry } from '../../plugin-runtime/registry/types.ts'
import type { PluginSettingOptionsContribution } from '../../plugin-runtime/settings/pluginSettingsTypes.ts'

interface FontContributionPickerProps {
  value: string
  role: FontRole
  ariaLabel: string
  onChange(value: string): void
  optionContributions?: readonly RegistryEntry<PluginSettingOptionsContribution>[]
  settingTarget: string
}

const FALLBACK_LABELS: Record<string, string> = {
  system: '系统无衬线',
  serif: '低对比阅读衬线',
  mono: 'Consolas（VS Code 默认）',
}

export default function FontContributionPicker({ value, role, ariaLabel, onChange, optionContributions = [], settingTarget }: FontContributionPickerProps) {
  const registry = getFontContributionRegistry()
  const entries = useSyncExternalStore(
    listener => registry.subscribe(listener),
    () => registry.getSnapshot(),
    () => registry.getSnapshot(),
  ).entries.filter(entry => entry.value.roles.includes(role))
  const selected = entries.find(entry => entry.value.id === value)?.value
  const resolved = resolvePluginSettingOptions(settingTarget, entries.map(entry => ({
    value: entry.value.id,
    label: entry.value.label,
    description: entry.value.description,
    order: entry.value.order,
  })), optionContributions)
  const choices = resolved.some(option => option.value === value)
    ? resolved
    : [{ value, label: `${FALLBACK_LABELS[value] ?? value}（已不可用）`, disabled: true }, ...resolved]
  const sample = selected?.sample ?? (role === 'code' ? 'const pylon = await connect()' : 'Pylon 让 Agent 工作变得清晰')
  const previewFamily = selected ? `var(${fontContributionCssVariable(selected.id)}, ${selected.family})` : 'inherit'

  return (
    <div className="font-contribution-picker">
      <Select ariaLabel={ariaLabel} className="set-select" value={value} onChange={onChange} options={choices.map(option => ({ value: option.value, label: option.label, description: option.description, disabled: option.disabled }))} />
      <span className="font-contribution-sample" style={{ fontFamily: previewFamily }}>{sample}</span>
      {selected?.description && <small>{selected.description}</small>}
    </div>
  )
}
