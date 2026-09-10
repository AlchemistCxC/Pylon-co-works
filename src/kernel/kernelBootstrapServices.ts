import { IS_TAURI } from '../infrastructure/tauri/env.ts'
import {
  bootstrapBuiltins,
  getPackageInstallationService,
  retryBuiltinPlugin,
} from '../plugin-runtime/pluginCompositionRoot.ts'
import { registerKernelBootstrapProvider } from '../plugin-runtime/management/pluginManagementWiring.ts'
import { applicationRuntime } from '../application/applicationRuntimeServices.ts'
import type { ApplicationMountPort } from '../application/applicationMountPort.ts'
import { createKernelBootstrap } from './kernelBootstrap.ts'

const bootstrap = createKernelBootstrap({
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

registerKernelBootstrapProvider(bootstrap)

export const kernelBootstrap = bootstrap
