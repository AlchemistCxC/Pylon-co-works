import { useSyncExternalStore } from 'react'
import { resolveInterfaceModeSuite } from '../../application/transactions/activateInterfaceMode.ts'
import { useInterfaceModeStore } from '../../domains/interface/interfaceModeStore.ts'
import { usePresentationPreferenceStore } from '../../domains/presentation/presentationPreferenceStore.ts'
import { BUILTIN_INTERFACE_MODES } from '../../plugins/core/interfaceMode/builtinInterfaceModes.ts'
import { getInterfaceModeRegistry, getRendererRegistry } from '../../plugin-runtime/runtimeServices.ts'
import Select from '../ui/Select.tsx'

/** Suite-level choice UI; message renderer ids are intentionally not exposed here. */
export default function RendererSuitePicker() {
  const modeId = useInterfaceModeStore(state => state.interfaceMode)
  const selectedByMode = usePresentationPreferenceStore(state => state.rendererSuiteIdByMode)
  const rendererRegistry = getRendererRegistry()
  const snapshot = useSyncExternalStore(
    listener => rendererRegistry.subscribe(listener),
    () => rendererRegistry.snapshot(),
    () => rendererRegistry.snapshot(),
  )
  const modeRegistry = getInterfaceModeRegistry()
  const mode = modeRegistry.resolve(modeId)?.value ?? BUILTIN_INTERFACE_MODES.find(entry => entry.id === modeId)
  if (!mode || mode.workbench.renderKind !== 'renderer-suite') return null
  const choices = resolveInterfaceModeSuite(mode, selectedByMode[modeId], snapshot.rendererSuites.map(entry => entry.value.id))
  const selectedId = choices.activeSuiteId ?? choices.requestedSuiteId ?? mode.workbench.defaultSuiteId
  const displayId = choices.unavailable && choices.requestedSuiteId ? choices.requestedSuiteId : selectedId
  const selected = snapshot.rendererSuites.find(entry => entry.value.id === selectedId)
  const options = snapshot.rendererSuites.map(entry => ({
    value: entry.value.id,
    label: `${entry.value.label} · ${entry.value.runtime.framework}/${entry.value.runtime.version}`,
    description: `${entry.value.requiredKinds.length} kinds · ${entry.value.compatibility.documentSchema}`,
  }))
  if (choices.requestedSuiteId && !options.some(option => option.value === choices.requestedSuiteId)) {
    options.push({
      value: choices.requestedSuiteId,
      label: `${choices.requestedSuiteId} · 插件暂不可用`,
      description: '保留偏好，等待插件恢复',
    })
  }
  return <div className="renderer-suite-picker" data-pylon-component="renderer-suite-picker">
    <div className="renderer-suite-picker-heading">
      <span><strong>Renderer Suite</strong><small>整套 Workbench；Interface Mode 仅提供默认值。</small></span>
      {choices.unavailable && <span role="status" className="renderer-suite-status">当前使用内置回退，偏好已保留</span>}
    </div>
    <Select
      ariaLabel="Renderer Suite"
      value={displayId}
      options={options}
      onChange={value => usePresentationPreferenceStore.getState().setRendererSuiteId(modeId, value)}
    />
    <div className="renderer-suite-details" role="status">
      {selected ? (
        <>
          <span>{selected.ownerPluginId} · {selected.value.runtime.framework}/{selected.value.runtime.version}</span>
          <span>兼容 {selected.value.compatibility.documentSchema} / catalog {selected.value.compatibility.renderCatalogSchema}</span>
          <span>覆盖 {selected.value.requiredKinds.length + (selected.value.optionalKinds?.length ?? 0)} kinds</span>
          {choices.activeSuiteId === selected.value.id && <span>active</span>}
        </>
      ) : <span>Suite 不可用：{choices.requestedSuiteId ?? mode.workbench.defaultSuiteId}</span>}
    </div>
  </div>
}
