// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import TacticalCommandDeck from '../TacticalCommandDeck'
import { useTacticalSceneStore } from '../tacticalSceneStore'
import { useInterfaceModeStore } from '../../domains/interface/interfaceModeStore'

describe('Tactical scene preferences', () => {
  beforeEach(() => useTacticalSceneStore.setState({ artwork: 'closer', opacity: 0.42, motion: true }))
  it('changes artwork and motion locally without changing the selected interface', () => {
    useInterfaceModeStore.setState({ interfaceMode: 'modern-gui' })
    render(<TacticalCommandDeck agents={0} connected={0} sessions={0} workspaces={0} busy={false} primaryLabel="接入 Agent" primaryDescription="配置" onPrimary={() => {}} onPanel={() => {}} onSettings={() => {}} onDiagnostics={() => {}} />)
    fireEvent.click(screen.getByText('场景与动效'))
    fireEvent.click(screen.getByRole('button', { name: '坠落 / FALLING' }))
    fireEvent.change(screen.getByRole('slider', { name: '背景强度' }), { target: { value: '55' } })
    fireEvent.click(screen.getByRole('checkbox', { name: '背景视差与缓动' }))
    expect(useTacticalSceneStore.getState()).toMatchObject({ artwork: 'falling', opacity: 0.55, motion: false })
    expect(useInterfaceModeStore.getState().interfaceMode).toBe('modern-gui')
  })
  it('bounds opacity so saved values cannot hide the reading plane', () => {
    useTacticalSceneStore.getState().setOpacity(10)
    expect(useTacticalSceneStore.getState().opacity).toBe(0.7)
    useTacticalSceneStore.getState().setOpacity(Number.NaN)
    expect(useTacticalSceneStore.getState().opacity).toBe(0.42)
  })
})
