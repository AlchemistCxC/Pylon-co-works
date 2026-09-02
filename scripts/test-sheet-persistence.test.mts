import { test } from 'vitest'
import { createPluginIdentity } from '../src/plugin-runtime/pluginIdentity.ts'
import { BUILTIN_WORKSPACE_TYPES } from '../src/plugins/core/sheet/builtinWorkspacePlugins.ts'
import { getWorkspaceRegistryStore } from '../src/workspace-sheets/workspaceRegistry.ts'

test('F0.2 Sheet 持久化 v1 迁移源回归', async () => {
  // composition root owns the compatibility registry; initialize it before
  // registering the test descriptors so the parser and wrapper share one store.
  await import('../src/plugin-runtime/pluginCompositionRoot.ts')
  const registry = getWorkspaceRegistryStore()
  const owner = createPluginIdentity('test.sheet-persistence', 'runtime')
  const registrations = BUILTIN_WORKSPACE_TYPES
    .filter(workspace => (workspace.kind === 'agent' || workspace.kind === 'file') && !registry.resolve(workspace.kind))
    .map(workspace => registry.register(owner, workspace))

  try {
    await import('./test-sheet-persistence.mts')
  } finally {
    for (const registration of registrations.reverse()) registration.dispose()
  }
})
