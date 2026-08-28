// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import Settings from '../Settings.tsx'

vi.mock('../settings/AgentRuntimePanel.tsx', () => ({
  default: () => <div data-testid="agent-runtime-panel">runtime onboarding</div>,
}))
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => null) }))

describe('B-03 Settings dialog semantics', () => {
  it('exposes dialog semantics and moves focus inside on open', () => {
    const opener = document.createElement('button')
    opener.type = 'button'
    opener.textContent = '打开设置'
    document.body.append(opener)
    opener.focus()

    const { container } = render(<Settings />)
    const dialog = screen.getByRole('dialog', { name: '设置' })
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(document.activeElement).not.toBe(opener)
    expect(dialog).toContainElement(document.activeElement)
    expect(container.querySelector('.settings-header h2')).toHaveAttribute('id', dialog.getAttribute('aria-labelledby'))
  })

  it('wraps Tab and Shift+Tab within Settings controls', () => {
    render(<Settings />)
    const dialog = screen.getByRole('dialog', { name: '设置' })
    const focusables = [...dialog.querySelectorAll<HTMLButtonElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])')]
    expect(focusables.length).toBeGreaterThan(1)

    const first = focusables[0]
    const last = focusables.at(-1)!
    last.focus()
    fireEvent.keyDown(last, { key: 'Tab' })
    expect(document.activeElement).toBe(first)

    first.focus()
    fireEvent.keyDown(first, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(last)
  })

  it('restores focus to the opener when the dialog closes', () => {
    const opener = document.createElement('button')
    opener.type = 'button'
    opener.textContent = '打开设置'
    document.body.append(opener)
    opener.focus()

    function Harness() {
      const [open, setOpen] = useState(true)
      return open ? <Settings onClose={() => setOpen(false)} /> : <span>closed</span>
    }

    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: '关闭设置' }))
    expect(document.activeElement).toBe(opener)
  })
})
