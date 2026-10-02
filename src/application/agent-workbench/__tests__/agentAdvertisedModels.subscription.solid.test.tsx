/** @jsxImportSource solid-js */
// @vitest-environment jsdom
/**
 * #515：React useSyncExternalStore 探针 → solid 信号探针（createResource 形态的订阅语义
 * 等价：多次订阅 + 配置更新不互相踩踏、无渲染环）。断言集逐字保留。
 */
import { render } from '@solidjs/testing-library'
import { createMemo } from 'solid-js'
import { afterEach, expect, it } from 'vitest'
import { useRuntimeStore } from '../../../domains/runtime/runtimeStore.ts'
import { agentAdvertisedModelEntries } from '../agentAdvertisedModels.ts'
import { createZustandSignal } from '../../../infrastructure/state/solidStoreBridge.ts'

afterEach(() => { useRuntimeStore.setState({ sessionConfig: {} }) })

it('supports simultaneous Agent Sheet subscriptions and config updates without a render loop', () => {
  useRuntimeStore.setState({ sessionConfig: {} })
  function AgentModels(props: { agentId: string }) {
    // 订阅语义与 React 版 useSyncExternalStore 对齐：memo 必须对 store 有响应式依赖，
    // 否则纯函数计算永不失效（React 版靠 hook 订阅，solid 版显式读 sessionConfig 切片）。
    const sessionConfig = createZustandSignal(useRuntimeStore, s => s.sessionConfig)
    const entries = createMemo(() => {
      void sessionConfig()
      return agentAdvertisedModelEntries(props.agentId)
    })
    return <output aria-label={props.agentId}>{entries().map(entry => entry.id).join(',')}</output>
  }
  const view = render(() => <><AgentModels agentId="agent-a" /><AgentModels agentId="agent-b" /></>)
  useRuntimeStore.getState().setSessionConfig({ agentId: 'agent-a', source: 'a' }, { models: ['model-a'] })
  useRuntimeStore.getState().setSessionConfig({ agentId: 'agent-b', source: 'b' }, { models: ['model-b'] })
  expect(view.getByLabelText('agent-a')).toHaveTextContent('model-a')
  expect(view.getByLabelText('agent-b')).toHaveTextContent('model-b')
  useRuntimeStore.getState().setSessionConfig({ agentId: 'agent-a', source: 'a' }, { models: ['new-a'] })
  expect(view.getByLabelText('agent-a')).toHaveTextContent('new-a')
  expect(view.getByLabelText('agent-b')).toHaveTextContent('model-b')
})
