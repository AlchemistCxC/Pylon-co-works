import { describe, expect, it } from 'vitest'
import { validateRendererSuiteReferences } from '../rendererSuiteReferences.ts'

const suite = (id: string) => ({ id }) as never
const mode = (id: string, suiteId: string, profileId = `${id}.profile`) => ({
  id,
  defaultPresentationProfileId: profileId,
  workbench: { renderKind: 'renderer-suite', defaultSuiteId: suiteId },
}) as never
const profile = (id: string, interfaceMode = 'modern-gui') => ({ id, interfaceMode }) as never

describe('renderer suite cross-registry references', () => {
  it('accepts a complete mode → suite/profile graph', () => {
    expect(() => validateRendererSuiteReferences({
      suites: [suite('builtin.solid')],
      modes: [mode('modern-gui', 'builtin.solid')],
      profiles: [profile('modern-gui.profile')],
    })).not.toThrow()
  })

  it('validates shellRecipeId references when the recipe graph is provided', () => {
    const mirrored = { id: 'example.shell.mirrored', label: 'Mirrored', sidebarSide: 'right', contextPanelSide: 'left' } as never
    const modeWithRecipe = (recipeId: string | undefined) => {
      const base = mode('modern-gui', 'builtin.solid') as Record<string, unknown>
      return (recipeId !== undefined ? { ...base, shellRecipeId: recipeId } : base) as never
    }
    expect(() => validateRendererSuiteReferences({
      suites: [suite('builtin.solid')], modes: [modeWithRecipe('example.shell.mirrored')],
      profiles: [profile('modern-gui.profile')], shellRecipes: [mirrored],
    })).not.toThrow()
    expect(() => validateRendererSuiteReferences({
      suites: [suite('builtin.solid')], modes: [modeWithRecipe('missing.recipe')],
      profiles: [profile('modern-gui.profile')], shellRecipes: [mirrored],
    })).toThrow(/shellRecipeId 未注册/)
  })

  it('rejects unknown suite, profile and mode references', () => {
    expect(() => validateRendererSuiteReferences({
      suites: [], modes: [mode('modern-gui', 'missing.suite')], profiles: [],
    })).toThrow(/未知 Presentation Profile/)
    expect(() => validateRendererSuiteReferences({
      suites: [suite('builtin.solid')], modes: [mode('modern-gui', 'missing.suite')], profiles: [profile('modern-gui.profile')],
    })).toThrow(/未知 Renderer Suite/)
    expect(() => validateRendererSuiteReferences({
      suites: [suite('builtin.solid')], modes: [mode('modern-gui', 'builtin.solid')], profiles: [profile('modern-gui.profile'), profile('custom.profile', 'missing-mode')],
    })).toThrow(/未知 Interface Mode/)
  })
})
