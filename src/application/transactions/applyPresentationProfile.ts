import { THEME_FIELD_DEFS, type ZoneName } from '../../themeFieldDefs.ts'
import type { PresentationProfileContribution } from '../../plugin-runtime/presentation/presentationProfileTypes.ts'
import type { ThemeSettings } from '../../store.ts'
import type { SettingWriteSource } from '../../domains/theme/settingProvenance.ts'
import type { PresetApplyResult } from '../../domains/theme/presetBundle.ts'

export interface ApplyPresentationProfilePorts {
  setZoneField(zone: ZoneName, patch: Partial<ThemeSettings>, source?: SettingWriteSource): void
  setActiveProfileId(id: string): void
}

let presentationApplyRevision = 0

/** Apply one coherent profile without resetting palette, backgrounds or user assets. */
export function applyPresentationProfile(
  profile: PresentationProfileContribution,
  ports: ApplyPresentationProfilePorts,
): PresetApplyResult {
  const revision = ++presentationApplyRevision
  try {
    const byZone = new Map<ZoneName, Partial<ThemeSettings>>()
    for (const [key, value] of Object.entries(profile.tokens)) {
      const definition = THEME_FIELD_DEFS[key as keyof typeof THEME_FIELD_DEFS]
      if (!definition || definition.meta) continue
      const zone = definition.zone
      byZone.set(zone, { ...byZone.get(zone), [key]: value })
    }
    // D-trace：profile 的 token 写入声明贡献者，与用户手动编辑可区分
    // （此前与手动编辑同漏斗同标记，zone 会被误标 custom 且无法溯源）。
    for (const [zone, patch] of byZone) ports.setZoneField(zone, patch, 'presentation-profile')
    ports.setActiveProfileId(profile.id)
    return { status: 'applied', id: profile.id, providers: Object.freeze(['builtin.presentation']), revision }
  } catch (error) {
    return {
      status: 'failed', id: profile.id, failedProvider: 'builtin.presentation',
      message: error instanceof Error ? error.message : String(error), rolledBack: false, revision,
    }
  }
}
