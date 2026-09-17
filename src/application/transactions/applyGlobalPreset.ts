import { GLOBAL_PRESETS, type GlobalPreset, type PresetName } from '../../presets.ts'
import { useStore, type ThemeSettings } from '../../store.ts'
import { getPresentationProfileRegistry } from '../../plugin-runtime/runtimeServices.ts'
import type { PresentationProfileRegistry } from '../../plugin-runtime/presentation/presentationProfileRegistry.ts'
import { activatePresentationProfile } from './activateInterfaceMode.ts'
import type { InterfaceModeTransactionPorts } from './activateInterfaceMode.ts'

export interface GlobalPresetTransactionPorts extends InterfaceModeTransactionPorts {}

/** 呈现方案注册表 resolve 的返回值形状 —— 从真实来源推导，不设类型出口的捷径。 */
type ResolvedProfile = NonNullable<ReturnType<PresentationProfileRegistry['resolve']>>['value']

/**
 * 一次全局预设应用的计划。它只描述「该不该写 / 该激活什么 / 该写什么」，
 * 不含执行能力：不持有 store、不持有注册表单例。
 */
export type GlobalPresetPlan =
  | { kind: 'skip' }
  | {
      kind: 'apply'
      presetName: GlobalPreset['name']
      theme: Partial<ThemeSettings>
      /** 有值 = 需先激活该呈现方案，激活成功才允许写主题 */
      activateProfileId?: string
    }

/**
 * 纯函数：算出全局预设的应用计划。同样输入必得同样输出，不产生副作用。
 *
 * 呈现方案由调用方查好、以纯查询函数传入 —— 查不到（undefined）即视为 skip，
 * 这正是「预设挂着 profile 但 profile 未注册」时的既有语义。
 */
export function planGlobalPreset(
  name: string,
  lookupProfile: (profileId: string) => ResolvedProfile | undefined,
): GlobalPresetPlan {
  const preset = GLOBAL_PRESETS.find(candidate => candidate.name === name)
  if (!preset) return { kind: 'skip' }

  if (!preset.presentationProfileId) {
    return { kind: 'apply', presetName: preset.name, theme: preset.theme }
  }

  const profile = lookupProfile(preset.presentationProfileId)
  if (!profile) return { kind: 'skip' }

  return {
    kind: 'apply',
    presetName: preset.name,
    theme: { ...preset.theme, ...profile.tokens },
    activateProfileId: profile.id,
  }
}

/**
 * 应用官方全局预设。带 Presentation Profile 的预设先激活目标模式，再把 Profile
 * token 合入完整主题提交；最终不会因 Profile 的分区写入把全局预设误标为“自定义”。
 *
 * 薄壳：只做三件事 —— 取全局单例、执行副作用（激活呈现方案、写主题）、回报成功与否。
 * 全部分支判断在 planGlobalPreset 里，副作用（activatePresentationProfile）留在这里。
 */
export function applyGlobalPreset(name: PresetName | string, ports?: GlobalPresetTransactionPorts): boolean {
  const registry = getPresentationProfileRegistry()
  const plan = planGlobalPreset(name, id => registry.resolve(id)?.value)
  if (plan.kind === 'skip') return false
  if (plan.activateProfileId !== undefined && !activatePresentationProfile(plan.activateProfileId, ports)) return false
  ;(ports?.theme ?? useStore).getState().setGlobalPreset(plan.presetName, plan.theme)
  return true
}
