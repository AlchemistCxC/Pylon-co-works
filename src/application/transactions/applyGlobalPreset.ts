import { GLOBAL_PRESETS, type GlobalPreset, type PresetInterfaceMode, type PresetName } from '../../presets/index.ts'
import {
  PRESET_ZONES,
  requireZoneRefs,
  type GlobalPresetZoneSlice,
  type ZoneRefMap,
} from '../../domains/theme/presetReducer.ts'
import { ZONE_PRESET_POOL, resolveZonePresetEntryTheme } from '../../zones/zonePresetPool.ts'
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
      /** 预设归属桶——区域引用表解析的桶边界（跨桶引用非法）。 */
      interfaceMode: PresetInterfaceMode
      theme: Partial<ThemeSettings>
      /** 有值 = 需先激活该呈现方案，激活成功才允许写主题 */
      activateProfileId?: string
      /**
       * 刀1（#223 · 预设组装）：区域引用表（已过完整性校验）。有值 = 走**逐区域装配**；
       * 无值（两条默认预设）⇒ 回落「整份 `theme`」路径。
       */
      zoneRefs?: ZoneRefMap
      /** 刀1（#223）：呈现方案覆盖层——**装配之后**叠加，优先级不变（token 覆盖预设值）。 */
      profileTokens?: Partial<ThemeSettings>
    }

/**
 * 纯函数：算出全局预设的应用计划。同样输入必得同样输出，不产生副作用。
 *
 * 呈现方案由调用方查好、以纯查询函数传入 —— 查不到（undefined）即视为 skip，
 * 这正是「预设挂着 profile 但 profile 未注册」时的既有语义。
 *
 * 刀1（#223）：带区域引用表的预设在这里过一次**完整性校验**——缺项 / 非区域键**抛错**，
 * 不静默回落（静默回落的症状是「预设装了但某个区域没跟上」，用户看不出原因）。
 */
export function planGlobalPreset(
  name: string,
  lookupProfile: (profileId: string) => ResolvedProfile | undefined,
): GlobalPresetPlan {
  const preset = GLOBAL_PRESETS.find(candidate => candidate.name === name)
  if (!preset) return { kind: 'skip' }

  const zoneRefs = preset.zoneRefs ? requireZoneRefs(preset.zoneRefs, `出厂预设 ${preset.name} 的区域引用表`) : undefined

  if (!preset.presentationProfileId) {
    return { kind: 'apply', presetName: preset.name, interfaceMode: preset.interfaceMode, theme: preset.theme, ...(zoneRefs ? { zoneRefs } : {}) }
  }

  const profile = lookupProfile(preset.presentationProfileId)
  if (!profile) return { kind: 'skip' }

  return {
    kind: 'apply',
    presetName: preset.name,
    interfaceMode: preset.interfaceMode,
    theme: { ...preset.theme, ...profile.tokens },
    activateProfileId: profile.id,
    ...(zoneRefs ? { zoneRefs, profileTokens: profile.tokens } : {}),
  }
}

/**
 * 刀1（#223）：把一套预设的**区域引用表**展开成逐区域的装配输入。
 *
 * 每个区域按 `(界面模式桶, 区域, 引用 id)` 在区域预设池里解析 ⇒ **跨桶 / 跨区域 / 不存在的引用
 * 一律抛错**（不静默回落）。取值复用池的既有解析 `resolveZonePresetEntryTheme`
 * （出厂条目 = 现场 `pickZoneFields(preset.theme, zone)`；刀2 把出厂条目落成数据后，同一处自动读新源）。
 *
 * 纯函数：只读 `ZONE_PRESET_POOL` 与 `GLOBAL_PRESETS` 两张构建时求值的表，不改任何状态。
 */
export function expandGlobalPresetZoneRefs(
  bucket: PresetInterfaceMode,
  zoneRefs: ZoneRefMap,
): GlobalPresetZoneSlice[] {
  return PRESET_ZONES.map(zone => {
    const presetId = zoneRefs[zone]
    const entry = (ZONE_PRESET_POOL[bucket][zone] ?? []).find(candidate => candidate.id === presetId)
    if (!entry) throw new Error(`区域引用解析不到：${bucket}/${zone} → ${presetId}`)
    const theme = resolveZonePresetEntryTheme(entry)
    if (!theme) throw new Error(`区域引用不可应用（来源缺失或占位条目）：${bucket}/${zone} → ${presetId}`)
    return { zone, presetName: presetId, theme }
  })
}

/**
 * 应用官方全局预设。带 Presentation Profile 的预设先激活目标模式，再把 Profile
 * token 合入完整主题提交；最终不会因 Profile 的分区写入把全局预设误标为“自定义”。
 *
 * 薄壳：只做三件事 —— 取全局单例、执行副作用（激活呈现方案、写主题）、回报成功与否。
 * 全部分支判断在 planGlobalPreset 里，副作用（activatePresentationProfile）留在这里。
 *
 * 刀1（#223）：写主题这一步分两条路 —— **有区域引用表的预设走逐区域装配**（把引用展开成
 * `{ zone, id, theme 切片 }` 后交纯层），**没有的（两条默认预设）回落整份 `theme`**。
 * 对外签名与返回值一字未变。
 */
export function applyGlobalPreset(name: PresetName | string, ports?: GlobalPresetTransactionPorts): boolean {
  const registry = getPresentationProfileRegistry()
  const plan = planGlobalPreset(name, id => registry.resolve(id)?.value)
  if (plan.kind === 'skip') return false
  if (plan.activateProfileId !== undefined && !activatePresentationProfile(plan.activateProfileId, ports)) return false
  const themeStore = (ports?.theme ?? useStore).getState()
  if (plan.zoneRefs) {
    themeStore.assembleGlobalPreset(
      expandGlobalPresetZoneRefs(plan.interfaceMode, plan.zoneRefs),
      plan.profileTokens ? { profileTokens: plan.profileTokens } : {},
    )
  } else {
    themeStore.setGlobalPreset(plan.presetName, plan.theme)
  }
  return true
}
