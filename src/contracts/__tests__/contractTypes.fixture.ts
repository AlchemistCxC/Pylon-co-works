import type { AgentEntry } from '../../identityStore.ts'
import type { CommandSetProvider } from '../agentCommandSet.ts'
import type { HookDefinition } from '../../plugin-runtime/hooks/hookTypes.ts'
import type { SearchProvider } from '../searchProvider.ts'
import type { SessionStateSyncProvider } from '../sessionStateSync.ts'

export const contractFixtures = {
  commandSet: { resolve: () => [] } satisfies CommandSetProvider,
  hook: { id: 'fixture.hook', mode: 'notification', handler: () => {} } satisfies HookDefinition,
  search: { providerId: 'fixture', mode: 'all', search: async () => ({ results: [], truncated: false }) } satisfies SearchProvider,
  sync: { providerId: 'fixture', applyResponse: (_context: unknown, _response: unknown) => {} } satisfies SessionStateSyncProvider,
} as const

export const agentFixture: AgentEntry = { id: 'fixture', name: 'Fixture' }
