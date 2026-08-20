import { getSpinnerVerbPreset, SPINNER_VERB_PRESETS, type SpinnerVerbPreset } from './spinnerAssets.ts'

export { SPINNER_VERB_PRESETS, type SpinnerVerbPreset }

export function normalizeSpinnerVerbs(value: string, fallback: readonly string[]): string[] {
  const verbs = Array.from(new Set(value.split(/\r?\n/).map(item => item.trim()).filter(Boolean)))
  return verbs.length > 0 ? verbs : [...fallback]
}

export function resolveSpinnerVerbs(preset: string, custom: string): string[] {
  const asset = getSpinnerVerbPreset(preset)
  return asset.id === 'custom'
    ? normalizeSpinnerVerbs(custom, getSpinnerVerbPreset('zh').verbs)
    : [...asset.verbs]
}
