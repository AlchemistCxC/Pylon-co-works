import { describe, expect, it } from 'vitest'
import { resolveRenderAppearance, type RenderAppearanceResolveInput } from '../renderAppearanceResolver.ts'
import type { RendererSettingsSchema } from '../rendererSettingsTypes.ts'

const schema: RendererSettingsSchema = {
  schemaVersion: 1,
  groups: [{ id: 'main', label: 'Main', fields: [
    { key: 'density', type: 'choice', presentation: 'select', options: [{ value: 'compact' }, { value: 'roomy' }], default: 'compact' },
    { key: 'scale', type: 'number', presentation: 'input', min: 50, max: 150, default: 100 },
  ] }],
}

function input(overrides: Partial<RenderAppearanceResolveInput> = {}): RenderAppearanceResolveInput {
  return {
    schema,
    hostDefaults: { density: 'compact', scale: 80 },
    kindDefaults: { density: 'roomy' },
    profileTokens: { density: 'compact' },
    userOverrides: { density: 'roomy', scale: 110 },
    sessionPreview: { density: 'compact' },
    ...overrides,
  }
}

describe('render appearance resolver', () => {
  it('按 host < kind < profile < user < preview 覆盖', () => {
    const result = resolveRenderAppearance(input())
    expect(result.values).toMatchObject({ density: 'compact', scale: 110 })
    expect(result.sources.density).toBe('session-preview')
    expect(result.sources.scale).toBe('user-override')
  })

  it('invalid override 回退并产生 diagnostic，unknown key 保留为 unavailable', () => {
    const result = resolveRenderAppearance(input({ userOverrides: { density: 'invalid', unknown: 'kept', scale: 999 } }))
    expect(result.values).toMatchObject({ density: 'compact', scale: 80 })
    expect(result.unavailable.unknown).toBe('kept')
    expect(result.diagnostics.map(item => item.code)).toEqual(expect.arrayContaining(['renderer.setting.invalid', 'renderer.setting.unavailable']))
  })

  it('option 被插件移除时标记 unavailable，不静默改写当前值', () => {
    const result = resolveRenderAppearance(input({ userOverrides: { density: 'roomy' }, availableOptions: { density: ['compact'] } }))
    expect(result.values.density).toBe('compact')
    expect(result.unavailable.density).toBe('roomy')
    expect(result.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'renderer.setting.unavailable', key: 'density' })]))
  })

  it('接受 optionTarget 当前有效列表中新加入的插件候选值', () => {
    const result = resolveRenderAppearance(input({
      userOverrides: { density: 'experimental' },
      sessionPreview: {},
      availableOptions: { density: ['compact', 'roomy', 'experimental'] },
    }))
    expect(result.values.density).toBe('experimental')
    expect(result.sources.density).toBe('user-override')
  })
})
