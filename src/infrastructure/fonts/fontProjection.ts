import type { RegistryEntry } from '../../plugin-runtime/registry/types.ts'
import { fontContributionCssVariable } from '../../plugin-runtime/fonts/fontContributionRegistry.ts'
import type { FontContribution } from '../../plugin-runtime/fonts/fontContributionTypes.ts'

export function projectFontContributions(
  root: HTMLElement,
  entries: readonly RegistryEntry<FontContribution>[],
): () => void {
  const previous = new Map<string, string>()
  for (const entry of entries) {
    const variable = fontContributionCssVariable(entry.value.id)
    previous.set(variable, root.style.getPropertyValue(variable))
    root.style.setProperty(variable, entry.value.family)
  }
  return () => {
    for (const [variable, value] of previous) {
      if (value) root.style.setProperty(variable, value)
      else root.style.removeProperty(variable)
    }
  }
}

