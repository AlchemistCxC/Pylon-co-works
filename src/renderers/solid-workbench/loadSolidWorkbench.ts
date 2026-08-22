import type { WorkbenchHostPort, WorkbenchMountInput, WorkbenchRendererInstance } from './workbenchContracts.ts'
import type { RendererActivationSnapshot } from '../../plugin-runtime/renderers/rendererSuiteTypes.ts'

interface SolidWorkbenchModule {
  mountSolidWorkbenchFromHostPort(input: { host: HTMLElement; input: WorkbenchMountInput; hostPort: WorkbenchHostPort; activation?: RendererActivationSnapshot }): WorkbenchRendererInstance
}

const modules = import.meta.glob<SolidWorkbenchModule>('./mountSolidWorkbench.solid.tsx')

export async function loadSolidWorkbench(): Promise<SolidWorkbenchModule> {
  const load = modules['./mountSolidWorkbench.solid.tsx']
  if (!load) throw new Error('Solid Workbench 未进入 Vite module graph')
  return load()
}
