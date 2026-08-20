import type { CommandSetDescriptor } from '../../contracts/agentCommandSet.ts'
import type { BuiltinPluginDefinition } from '../pluginRuntime.ts'

export function createBuiltinCommandPluginDefinition(
  id: string,
  definitions: readonly CommandSetDescriptor[],
): BuiltinPluginDefinition {
  return {
    id,
    activate: ({ commands }) => {
      for (const command of definitions) {
        commands.register({
          ...command,
          id: command.name,
        }, {
          contributionId: `${id}.${command.name}`,
          layer: 'platform',
          priority: command.priority,
        })
      }
    },
  }
}
