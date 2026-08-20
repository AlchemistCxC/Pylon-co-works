import { useSyncExternalStore } from 'react'
import { applyPresentationProfile } from '../../application/transactions/applyPresentationProfile.ts'
import { usePresentationPreferenceStore } from '../../domains/presentation/presentationPreferenceStore.ts'
import { getPresentationProfileRegistry, getRendererRegistry } from '../../plugin-runtime/runtimeServices.ts'
import { useStore } from '../../store.ts'
import Select from '../ui/Select.tsx'
import { presentationProfileInterfaceMode } from '../../application/transactions/activateInterfaceMode.ts'
import { useInterfaceModeStore } from '../../domains/interface/interfaceModeStore.ts'

export default function PresentationProfilePicker() {
  const profileRegistry = getPresentationProfileRegistry()
  const rendererRegistry = getRendererRegistry()
  const profiles = useSyncExternalStore(
    listener => profileRegistry.subscribe(listener),
    () => profileRegistry.getSnapshot(),
    () => profileRegistry.getSnapshot(),
  ).entries
  const renderers = useSyncExternalStore(
    listener => rendererRegistry.subscribe(listener),
    () => rendererRegistry.snapshot(),
    () => rendererRegistry.snapshot(),
  ).messageRenderers
  const activeProfileId = usePresentationPreferenceStore(state => state.activeProfileId)
  const interfaceMode = useInterfaceModeStore(state => state.interfaceMode)
  const rendererId = usePresentationPreferenceStore(state => state.messageRendererId)
  const familyLabels: Record<string, string> = { terminal: '终端', reading: '阅读', hybrid: '混合', gui: 'GUI', custom: '插件' }

  const activate = (id: string) => {
    const profile = profileRegistry.resolve(id)?.value
    if (!profile) return
    applyPresentationProfile(profile, {
      setZoneField: (zone, patch) => useStore.getState().setZoneField(zone, patch),
      setActiveProfileId: next => {
        usePresentationPreferenceStore.getState().setActiveProfileId(next)
        useInterfaceModeStore.getState().rememberProfile(interfaceMode, next)
      },
    })
  }

  return (
    <div className="presentation-settings" data-pylon-component="presentation-profile-picker">
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
      <div className="presentation-renderer-row">
        <span><strong>渲染引擎</strong><small>风格与技术引擎独立；自动模式允许插件按上下文接管。</small></span>
        <Select ariaLabel="渲染引擎" value={rendererId} onChange={value => usePresentationPreferenceStore.getState().setMessageRendererId(value)} options={[
          { value: 'auto', label: '自动选择' },
          ...renderers.map(entry => ({ value: entry.value.renderer.rendererId, label: `${entry.value.label || entry.value.renderer.rendererId}${entry.value.experimental ? ' · 实验' : ''}` })),
        ]} />
      </div>
    </div>
  )
}
