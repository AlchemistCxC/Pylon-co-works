import type { PluginIdentity } from '../pluginIdentity.ts'
import type { PluginScope } from '../pluginScope.ts'
import type { SessionCreationRegistry, SessionCreationRegistryTransaction } from './sessionCreationRegistry.ts'
import type { SessionCreationArtifactHandler, SessionCreationCompiler, SessionCreationContribution } from './sessionCreationTypes.ts'

export interface PluginSessionCreationApi {
  registerContribution(contribution: SessionCreationContribution): void
  registerCompiler(compiler: SessionCreationCompiler): void
  registerArtifactHandler(handler: SessionCreationArtifactHandler): void
}

export function createPluginSessionCreationApi(
  registry: SessionCreationRegistry,
  identity: PluginIdentity,
  scope: PluginScope,
  transaction?: SessionCreationRegistryTransaction,
): PluginSessionCreationApi {
  const own = (registration: { dispose(): void | Promise<void> }) => {
    try { scope.add(registration) } catch (error) { void registration.dispose(); throw error }
  }
  return {
    registerContribution(contribution) {
      own(transaction
        ? transaction.registerContribution(contribution)
        : registry.registerContribution(identity, contribution))
    },
    registerCompiler(compiler) {
      own(transaction
        ? transaction.registerCompiler(compiler)
        : registry.registerCompiler(identity, compiler))
    },
    registerArtifactHandler(handler) {
      own(transaction
        ? transaction.registerArtifactHandler(handler)
        : registry.registerArtifactHandler(identity, handler))
    },
  }
}
