// @vitest-environment jsdom
import { useSyncExternalStore } from 'react'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { useRuntimeStore } from '../../../domains/runtime/runtimeStore.ts'
import { agentAdvertisedModelEntries } from '../agentAdvertisedModels.ts'

afterEach(cleanup)

it('supports simultaneous Agent Sheet subscriptions and config updates without a render loop', () => {
  useRuntimeStore.setState({ sessionConfig: {} })
  function AgentModels({ agentId }: { agentId: string }) {
    const entries = useSyncExternalStore(
      useRuntimeStore.subscribe,
      () => agentAdvertisedModelEntries(agentId),
    )
    return <output aria-label={agentId}>{entries.map(entry => entry.id).join(',')}</output>
  }
  const view = render(<><AgentModels agentId="agent-a" /><AgentModels agentId="agent-b" /></>)
  act(() => {
    useRuntimeStore.getState().setSessionConfig({ agentId: 'agent-a', source: 'a' }, { models: ['model-a'] })
    useRuntimeStore.getState().setSessionConfig({ agentId: 'agent-b', source: 'b' }, { models: ['model-b'] })
  })
  expect(view.getByLabelText('agent-a')).toHaveTextContent('model-a')
  expect(view.getByLabelText('agent-b')).toHaveTextContent('model-b')
  act(() => useRuntimeStore.getState().setSessionConfig({ agentId: 'agent-a', source: 'a' }, { models: ['new-a'] }))
  expect(view.getByLabelText('agent-a')).toHaveTextContent('new-a')
  expect(view.getByLabelText('agent-b')).toHaveTextContent('model-b')
})
