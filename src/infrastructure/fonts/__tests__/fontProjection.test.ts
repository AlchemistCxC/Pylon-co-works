// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { projectFontContributions } from '../fontProjection.ts'

describe('font contribution CSS projection', () => {
  it('projects plugin families and restores previous root values on dispose', () => {
    const root = document.createElement('div')
    root.style.setProperty('--pylon-font-existing', 'Existing')
    const dispose = projectFontContributions(root, [{
      ownerPluginId: 'vendor.fonts',
      ownerRuntimeInstanceId: 'runtime-1',
      contributionId: 'vendor.code',
      layer: 'feature',
      priority: 100,
      value: {
        id: 'vendor.code',
        label: 'Vendor Code',
        family: "'Vendor Code', monospace",
        roles: ['code'],
      },
    }])

    expect(root.style.getPropertyValue('--pylon-font-vendor-code')).toBe("'Vendor Code', monospace")
    expect(root.style.getPropertyValue('--pylon-font-existing')).toBe('Existing')

    dispose()
    expect(root.style.getPropertyValue('--pylon-font-vendor-code')).toBe('')
    expect(root.style.getPropertyValue('--pylon-font-existing')).toBe('Existing')
  })
})
