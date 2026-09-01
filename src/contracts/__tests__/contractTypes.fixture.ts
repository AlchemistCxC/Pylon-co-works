import type { AgentEntry } from '../../identityStore.ts'
import type { CommandSetProvider } from '../agentCommandSet.ts'
import type { HookRunner } from '../agentHook.ts'
import type { SearchProvider } from '../searchProvider.ts'
import type { SessionStateSyncProvider } from '../sessionStateSync.ts'

export const contractFixtures = {
  commandSet: { resolve: () => [] } satisfies CommandSetProvider,
  hook: { phases: ['session.start'], run: () => ({ effect: 'observe' }) } satisfies HookRunner,
  search: { providerId: 'fixture', mode: 'all', search: async () => ({ results: [], truncated: false }) } satisfies SearchProvider,
  sync: { providerId: 'fixture', applyResponse: (_context: unknown, _response: unknown) => {} } satisfies SessionStateSyncProvider,
} as const

export const agentFixture: AgentEntry = { id: 'fixture', name: 'Fixture' }
