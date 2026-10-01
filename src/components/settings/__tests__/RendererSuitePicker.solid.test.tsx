// @vitest-environment jsdom
// #515：迁移自 RendererSuitePicker.test.tsx（React RTL → Solid 实体直连；
// 断言集原样保留，仅 render/cleanup 形态差异）。
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@solidjs/testing-library'
import RendererSuitePicker from '../RendererSuitePicker.solid.tsx'
import { useInterfaceModeStore } from '../../../domains/interface/interfaceModeStore.ts'
import { usePresentationPreferenceStore } from '../../../domains/presentation/presentationPreferenceStore.ts'

afterEach(() => cleanup())

describe('RendererSuitePicker', () => {
  beforeEach(() => {
    useInterfaceModeStore.setState(useInterfaceModeStore.getInitialState(), true)
    usePresentationPreferenceStore.setState({
      ...usePresentationPreferenceStore.getInitialState(),
      rendererSuiteIdByMode: { 'modern-gui': 'plugin.missing.suite' },
    }, true)
  })

  it('shows an unavailable preference while keeping the requested Suite visible', () => {
    render(() => <RendererSuitePicker />)
    expect(screen.getByLabelText('Renderer Suite')).toBeTruthy()
    expect(screen.getByText(/当前使用内置回退/)).toBeTruthy()
    expect(screen.getByText(/Suite 不可用：plugin\.missing\.suite/)).toBeTruthy()
  })
})
