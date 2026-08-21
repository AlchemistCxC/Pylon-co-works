// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import RendererSuitePicker from '../RendererSuitePicker.tsx'
import { useInterfaceModeStore } from '../../../domains/interface/interfaceModeStore.ts'
import { usePresentationPreferenceStore } from '../../../domains/presentation/presentationPreferenceStore.ts'

describe('RendererSuitePicker', () => {
  beforeEach(() => {
    useInterfaceModeStore.setState(useInterfaceModeStore.getInitialState(), true)
    usePresentationPreferenceStore.setState({
      ...usePresentationPreferenceStore.getInitialState(),
      rendererSuiteIdByMode: { 'modern-gui': 'plugin.missing.suite' },
    }, true)
  })

  it('shows an unavailable preference while keeping the requested Suite visible', () => {
    render(<RendererSuitePicker />)
    expect(screen.getByLabelText('Renderer Suite')).toBeTruthy()
    expect(screen.getByText(/当前使用内置回退/)).toBeTruthy()
    expect(screen.getByText(/Suite 不可用：plugin\.missing\.suite/)).toBeTruthy()
  })
})
