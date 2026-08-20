import { lazy } from 'react'
import type { BuiltinPluginDefinition } from '../../plugin-runtime/pluginRuntime.ts'
import { BUILTIN_PYLON_SHELL_ID } from './productPluginIds.ts'
import { applicationRuntime } from '../../kernel/applicationRuntimeServices.ts'
import { mountFirstPartyStyleAssets } from './firstPartyStyleRuntime.ts'
import { loadBuiltinPylonShellStyles } from './packages/builtin.pylon-shell/styleAssets.ts'
import { createBuiltinShellCommandDefinitions } from '../core/shell/builtinShellCommands.ts'

const PylonApplication = lazy(() => import('../../App.tsx'))

export function createBuiltinPylonShellPlugin(): BuiltinPluginDefinition {
  return {
    id: BUILTIN_PYLON_SHELL_ID,
    kind: 'shell',
    firstParty: true,
    dependencies: ['builtin.pylon-workspace', 'builtin.pylon-renderers', 'builtin.pylon-agent-adapters', 'builtin.pylon-tools'],
    hotSwapMode: 'soft-remount',
    activate: ({ application, commands, identity, scope }) => {
      mountFirstPartyStyleAssets(BUILTIN_PYLON_SHELL_ID, identity.key, scope, loadBuiltinPylonShellStyles())
      application.register({ id: BUILTIN_PYLON_SHELL_ID, component: PylonApplication })
      if (applicationRuntime.getSnapshot().activeApplicationId === null) {
        applicationRuntime.mount(BUILTIN_PYLON_SHELL_ID)
      }
      for (const command of createBuiltinShellCommandDefinitions()) {
        commands.register(command, { contributionId: `${BUILTIN_PYLON_SHELL_ID}.${command.id}`, layer: 'feature', priority: command.priority })
      }
    },
  }
}
