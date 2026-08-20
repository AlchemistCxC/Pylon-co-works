import { THEME_FIELD_DEFS, type ZoneName } from '../../themeFieldDefs.ts'
import type { PresentationProfileContribution } from '../../plugin-runtime/presentation/presentationProfileTypes.ts'
import type { ThemeSettings } from '../../store.ts'

export interface ApplyPresentationProfilePorts {
  setZoneField(zone: ZoneName, patch: Partial<ThemeSettings>): void
  setActiveProfileId(id: string): void
}

/** Apply one coherent profile without resetting palette, backgrounds or user assets. */
export function applyPresentationProfile(
  profile: PresentationProfileContribution,
  ports: ApplyPresentationProfilePorts,
): void {
  const byZone = new Map<ZoneName, Partial<ThemeSettings>>()
  for (const [key, value] of Object.entries(profile.tokens)) {
    const definition = THEME_FIELD_DEFS[key as keyof typeof THEME_FIELD_DEFS]
    if (!definition || definition.meta) continue
    const zone = definition.zone
    byZone.set(zone, { ...byZone.get(zone), [key]: value })
  }
  for (const [zone, patch] of byZone) ports.setZoneField(zone, patch)
  ports.setActiveProfileId(profile.id)
}

