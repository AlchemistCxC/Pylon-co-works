import type {
  SolidWorkbenchSmokeInput,
  SolidWorkbenchSmokeLifecycle,
} from './solidWorkbenchSmokeContracts.ts'

interface SolidWorkbenchSmokeModule {
  mountSolidWorkbenchSmoke(
    host: HTMLElement,
    initialInput: SolidWorkbenchSmokeInput,
  ): SolidWorkbenchSmokeLifecycle
}

const smokeModules = import.meta.glob<SolidWorkbenchSmokeModule>(
  './mountSolidWorkbenchSmoke.solid.tsx',
)

export async function loadSolidWorkbenchSmoke(): Promise<SolidWorkbenchSmokeModule> {
  const load = smokeModules['./mountSolidWorkbenchSmoke.solid.tsx']
  if (!load) throw new Error('Solid Workbench smoke renderer 未进入 Vite module graph')
  return load()
}
