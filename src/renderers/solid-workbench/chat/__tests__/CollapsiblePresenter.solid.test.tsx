// @vitest-environment jsdom
import { cleanup, render, screen } from '@solidjs/testing-library'
import { createSignal } from 'solid-js'
import { afterEach, describe, expect, it } from 'vitest'
import { createCollapsiblePresenter } from '../CollapsiblePresenter.solid.tsx'

afterEach(cleanup)

describe('createCollapsiblePresenter', () => {
  it('keeps user intent across ordinary streaming updates', () => {
    const [text, setText] = createSignal('first')
    function Fixture() {
      const collapse = createCollapsiblePresenter({ defaultOpen: () => false })
      return <button aria-expanded={collapse.open()} aria-controls={collapse.bodyId}
        onClick={collapse.toggle}>{text()}</button>
    }
    render(() => <Fixture />)

    const trigger = screen.getByRole('button')
    trigger.click()
    setText('streamed')

    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    expect(trigger).toHaveTextContent('streamed')
  })

  it('resets to the current default when semantic identity changes', () => {
    const [identity, setIdentity] = createSignal('tool-a')
    const [defaultOpen, setDefaultOpen] = createSignal(false)
    function Fixture() {
      const collapse = createCollapsiblePresenter({
        defaultOpen,
        resetKey: identity,
        bodyId: () => `body-${identity()}`,
      })
      return <button aria-expanded={collapse.open()} aria-controls={collapse.bodyId} onClick={collapse.toggle}>toggle</button>
    }
    render(() => <Fixture />)

    const trigger = screen.getByRole('button')
    trigger.click()
    setDefaultOpen(true)
    expect(trigger).toHaveAttribute('aria-expanded', 'true')

    setDefaultOpen(false)
    setIdentity('tool-b')
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(trigger).toHaveAttribute('aria-controls', 'body-tool-b')
  })

  it('only follows presentation default changes when explicitly requested', () => {
    const [defaultOpen, setDefaultOpen] = createSignal(false)
    function Fixture() {
      const stable = createCollapsiblePresenter({ defaultOpen })
      const preview = createCollapsiblePresenter({ defaultOpen, resetOnDefaultChange: true })
      return <>
        <button aria-label="stable" aria-expanded={stable.open()} onClick={stable.toggle}>stable</button>
        <button aria-label="preview" aria-expanded={preview.open()} onClick={preview.toggle}>preview</button>
      </>
    }
    render(() => <Fixture />)

    screen.getByRole('button', { name: 'stable' }).click()
    setDefaultOpen(true)
    expect(screen.getByRole('button', { name: 'stable' })).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('button', { name: 'preview' })).toHaveAttribute('aria-expanded', 'true')

    setDefaultOpen(false)
    expect(screen.getByRole('button', { name: 'stable' })).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('button', { name: 'preview' })).toHaveAttribute('aria-expanded', 'false')
  })
})
