// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useStore } from '../../../store.ts'
import { resetStores } from '../../../test/resetStores.ts'
import { getPresentationProfileRegistry } from '../../../plugin-runtime/runtimeServices.ts'
import { createPluginIdentity } from '../../../plugin-runtime/pluginIdentity.ts'
import PresentationProfilePicker from '../PresentationProfilePicker.tsx'

const registrations: Array<{ dispose(): void | Promise<void> }> = []

afterEach(async () => {
  cleanup()
  while (registrations.length > 0) await registrations.pop()!.dispose()
})

describe('PresentationProfilePicker', () => {
  beforeEach(() => resetStores())

  it('waits for the shared profile result seam and reports success', async () => {
    const profileId = `test.presentation.result.${Date.now()}`
    const owner = createPluginIdentity(profileId, '1')
    registrations.push(getPresentationProfileRegistry().register(owner, {
      id: profileId, label: '结果风格', family: 'custom', interfaceMode: 'modern-gui',
      tokens: { chatFontSize: 18 },
    }))
    render(<PresentationProfilePicker />)

    fireEvent.click(screen.getByRole('button', { name: /结果风格/ }))
    expect(await screen.findByRole('status')).toHaveTextContent('呈现风格已应用')
    expect(useStore.getState().chatFontSize).toBe(18)
  })

  it('shows a failed result when a profile owner rejects a write', async () => {
    const profileId = `test.presentation.failure.${Date.now()}`
    const owner = createPluginIdentity(profileId, '1')
    registrations.push(getPresentationProfileRegistry().register(owner, {
      id: profileId, label: '失败风格', family: 'custom', interfaceMode: 'modern-gui',
      tokens: { chatFontSize: 18 },
    }))
    useStore.setState({ setZoneField: () => { throw new Error('theme owner rejected') } } as never)
    render(<PresentationProfilePicker />)

    fireEvent.click(screen.getByRole('button', { name: /失败风格/ }))
    expect(await screen.findByRole('alert')).toHaveTextContent('builtin.presentation')
  })
})
