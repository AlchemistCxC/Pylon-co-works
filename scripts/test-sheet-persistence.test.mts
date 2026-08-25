import { test } from 'vitest'
import { createPluginIdentity } from '../src/plugin-runtime/pluginIdentity.ts'
import { BUILTIN_WORKSPACE_TYPES } from '../src/plugins/core/sheet/builtinWorkspacePlugins.ts'
import { getWorkspaceRegistryStore } from '../src/workspace-sheets/workspaceRegistry.ts'

test('F0.2 Sheet 持久化 v1 迁移源回归', async () => {
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
