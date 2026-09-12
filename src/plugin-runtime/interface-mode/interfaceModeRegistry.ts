import { ValidatedContributionRegistry } from '../registry/validatedContributionRegistry.ts'
import type { InterfaceModeContribution } from './interfaceModeTypes.ts'

export const INTERFACE_MODE_ID_PATTERN = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/

function validateSurfaceId(value: string, label: string): void {
  if (!value || value !== value.trim()) throw new Error(`${label} surfaceId 非法`)
}

export function validateInterfaceModeContribution(
  contribution: InterfaceModeContribution,
): InterfaceModeContribution {
  if (!INTERFACE_MODE_ID_PATTERN.test(contribution.id)) throw new Error(`Interface Mode id 非法：${contribution.id}`)
  if (!contribution.label?.trim()) throw new Error(`Interface Mode label 不能为空：${contribution.id}`)
  if (!contribution.defaultPresentationProfileId?.trim()) {
    throw new Error(`Interface Mode defaultPresentationProfileId 不能为空：${contribution.id}`)
  }
  if (contribution.order !== undefined && !Number.isFinite(contribution.order)) {
    throw new Error(`Interface Mode order 非法：${contribution.id}`)
  }
  if (contribution.quickSwitchTargetId !== undefined
    && !INTERFACE_MODE_ID_PATTERN.test(contribution.quickSwitchTargetId)) {
    throw new Error(`Interface Mode quickSwitchTargetId 非法：${contribution.id}`)
  }
  if (contribution.chromeStyle !== 'icons' && contribution.chromeStyle !== 'glyphs') {
    throw new Error(`Interface Mode chromeStyle 非法：${contribution.id}`)
  }
  if (contribution.workbench.renderKind === 'renderer-suite') {
    if (!contribution.workbench.defaultSuiteId?.trim()) {
      throw new Error(`Interface Mode ${contribution.id} workbench defaultSuiteId 不能为空`)
    }
  } else if (contribution.workbench.renderKind === 'isolated-surface') {
    validateSurfaceId(contribution.workbench.surfaceId, `Interface Mode ${contribution.id} workbench`)
  } else if (contribution.workbench.renderKind !== 'host'
    || (contribution.workbench.renderer !== 'modern' && contribution.workbench.renderer !== 'terminal')) {
    throw new Error(`Interface Mode workbench 非法：${contribution.id}`)
  }
  if (contribution.shellSurface) {
    validateSurfaceId(contribution.shellSurface.surfaceId, `Interface Mode ${contribution.id} shell`)
    if (contribution.shellSurface.placement !== 'before-workspace'
      && contribution.shellSurface.placement !== 'overlay') {
      throw new Error(`Interface Mode shell placement 非法：${contribution.id}`)
    }
  }
  return Object.freeze({
    ...contribution,
    workbench: Object.freeze({ ...contribution.workbench }),
    ...(contribution.shellSurface ? { shellSurface: Object.freeze({ ...contribution.shellSurface }) } : {}),
  })
}

export class InterfaceModeRegistry extends ValidatedContributionRegistry<InterfaceModeContribution> {
  constructor() { super(validateInterfaceModeContribution) }
}
