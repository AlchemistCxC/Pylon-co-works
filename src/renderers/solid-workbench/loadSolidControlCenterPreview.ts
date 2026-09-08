import type { SolidWorkbenchServices } from './workbenchContracts.ts'

interface SolidControlCenterPreviewModule {
  mountSolidControlCenterPreview(input: {
    host: HTMLElement
    services: SolidWorkbenchServices
  }): () => void
}

// Keep the Solid JSX module behind a Vite glob boundary. React's root
// TypeScript project intentionally excludes *.solid.tsx; a static import from
// SettingsPreview would make tsc follow that graph with the React JSX types.
const modules = import.meta.glob<SolidControlCenterPreviewModule>(
  './__fixtures__/mountSolidControlCenterPreview.solid.tsx',
)

export async function loadSolidControlCenterPreview(): Promise<SolidControlCenterPreviewModule> {
  const load = modules['./__fixtures__/mountSolidControlCenterPreview.solid.tsx']
  if (!load) throw new Error('Solid control-center preview 未进入 Vite module graph')
  return load()
}

