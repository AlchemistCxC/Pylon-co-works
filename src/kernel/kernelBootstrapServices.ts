import { IS_TAURI } from '../infrastructure/tauri/env.ts'
import {
  bootstrapBuiltins,
  getPackageInstallationService,
  retryBuiltinPlugin,
} from '../plugin-runtime/pluginCompositionRoot.ts'
import { applicationRuntime } from '../application/applicationRuntimeServices.ts'
import type { ApplicationMountPort } from '../application/applicationMountPort.ts'
import { createKernelBootstrap } from './kernelBootstrap.ts'

export const kernelBootstrap = createKernelBootstrap({
  bootstrapBuiltins,
  retryBuiltin: retryBuiltinPlugin,
  applicationMount: {
    mount: applicationId => applicationRuntime.mount(applicationId),
    unmount: () => applicationRuntime.unmount(),
  } satisfies ApplicationMountPort,
  initializeUserPackages: () => IS_TAURI
    ? getPackageInstallationService().emitActivationEvent('kernel.ready')
    : Promise.resolve({ activated: [], failed: [] }),
})
