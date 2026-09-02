import { useState, useSyncExternalStore } from 'react'
import { applyPresentationProfile } from '../../application/transactions/applyPresentationProfile.ts'
import { usePresentationPreferenceStore } from '../../domains/presentation/presentationPreferenceStore.ts'
import { getPresentationProfileRegistry } from '../../plugin-runtime/runtimeServices.ts'
import { useStore } from '../../store.ts'
import { presentationProfileInterfaceMode } from '../../application/transactions/activateInterfaceMode.ts'
import { useInterfaceModeStore } from '../../domains/interface/interfaceModeStore.ts'

export default function PresentationProfilePicker() {
  const profileRegistry = getPresentationProfileRegistry()
  const profiles = useSyncExternalStore(
    listener => profileRegistry.subscribe(listener),
    () => profileRegistry.getSnapshot(),
    () => profileRegistry.getSnapshot(),
  ).entries
  const activeProfileId = usePresentationPreferenceStore(state => state.activeProfileId)
  const interfaceMode = useInterfaceModeStore(state => state.interfaceMode)
  const [feedback, setFeedback] = useState<{ kind: 'success' | 'error'; message: string } | null>(null)
  const familyLabels: Record<string, string> = { terminal: '终端', reading: '阅读', hybrid: '混合', gui: 'GUI', custom: '插件' }

  const activate = (id: string) => {
    const profile = profileRegistry.resolve(id)?.value
    if (!profile) {
      setFeedback({ kind: 'error', message: `呈现风格不存在：${id}` })
      return
    }
    const result = applyPresentationProfile(profile, {
      setZoneField: (zone, patch, source) => useStore.getState().setZoneField(zone, patch, source),
      setActiveProfileId: next => {
        usePresentationPreferenceStore.getState().setActiveProfileId(next)
        useInterfaceModeStore.getState().rememberProfile(interfaceMode, next)
      },
    })
    setFeedback(result.status === 'applied'
      ? { kind: 'success', message: '呈现风格已应用' }
      : { kind: 'error', message: `呈现风格应用失败（${result.failedProvider}）：${result.message}` })
  }

  return (
    <div className="presentation-settings" data-pylon-component="presentation-profile-picker">
      {feedback && <div className={`presentation-profile-feedback is-${feedback.kind}`} role={feedback.kind === 'error' ? 'alert' : 'status'} aria-live="polite">{feedback.message}</div>}
      <div className="presentation-profile-grid" aria-label="渲染风格">
        {profiles.filter(entry => presentationProfileInterfaceMode(entry.value) === interfaceMode).map(entry => {
          const profile = entry.value
          const active = profile.id === activeProfileId
          return (
            <button
              key={profile.id}
              type="button"
              className={`presentation-profile-card${active ? ' active' : ''}`}
              onClick={() => activate(profile.id)}
              aria-pressed={active}
            >
              <span className="presentation-profile-asset" aria-hidden="true">
                {profile.assets?.assistantGlyph || profile.assets?.promptGlyph || '◆'}
              </span>
              <span className="presentation-profile-copy">
                <strong>{profile.label}</strong>
                <small>{profile.description || profile.family}</small>
              </span>
              <span className="presentation-profile-family">{familyLabels[profile.family] ?? profile.family}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
