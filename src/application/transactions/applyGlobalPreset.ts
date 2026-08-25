import { GLOBAL_PRESETS, type PresetName } from '../../presets.ts'
import { getPresentationProfileRegistry } from '../../plugin-runtime/runtimeServices.ts'
import { useStore } from '../../store.ts'
import { activatePresentationProfile } from './activateInterfaceMode.ts'

/**
 * 应用官方全局预设。带 Presentation Profile 的预设先激活目标模式，再把 Profile
 * token 合入完整主题提交；最终不会因 Profile 的分区写入把全局预设误标为“自定义”。
 */
export function applyGlobalPreset(name: PresetName | string): boolean {
  const preset = GLOBAL_PRESETS.find(candidate => candidate.name === name)
  if (!preset) return false

  if (!preset.presentationProfileId) {
    useStore.getState().setGlobalPreset(preset.name, preset.theme)
    return true
  }
  const profile = getPresentationProfileRegistry().resolve(preset.presentationProfileId)?.value
  if (!profile || !activatePresentationProfile(profile.id)) return false
  useStore.getState().setGlobalPreset(preset.name, { ...preset.theme, ...profile.tokens })
  return true
}
