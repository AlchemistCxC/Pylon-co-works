import { IS_TAURI } from '../infrastructure/tauri/env.ts'
import {
  bootstrapBuiltins,
  getPackageInstallationService,
  retryBuiltinPlugin,
} from '../plugin-runtime/pluginCompositionRoot.ts'
import { applicationRuntime } from './applicationRuntimeServices.ts'
import { createKernelBootstrap } from './kernelBootstrap.ts'

export const kernelBootstrap = createKernelBootstrap({
  bootstrapBuiltins,
  retryBuiltin: retryBuiltinPlugin,
  mountApplication: applicationId => applicationRuntime.mount(applicationId),
  unmountApplication: () => applicationRuntime.unmount(),
  initializeUserPackages: () => IS_TAURI
    ? getPackageInstallationService().emitActivationEvent('kernel.ready')
    : Promise.resolve({ activated: [], failed: [] }),
})
