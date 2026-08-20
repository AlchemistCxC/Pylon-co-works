// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it } from 'vitest'
import CollapsibleRegion from '../CollapsibleRegion.tsx'

function Fixture() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" aria-expanded={open} aria-controls="content" onClick={() => setOpen(value => !value)}>切换</button>
      <CollapsibleRegion open={open} id="content"><p>保持挂载的正文</p></CollapsibleRegion>
    </>
  )
}

describe('CollapsibleRegion', () => {
  it('折叠时保留正文以支持退场动画，同时从可访问树隐藏', () => {
    const { container } = render(<Fixture />)
    const region = container.querySelector('.term-collapse')
    expect(region).toHaveAttribute('data-open', 'false')
    expect(region).toHaveAttribute('aria-hidden', 'true')
    expect(region?.textContent).toContain('保持挂载的正文')

    fireEvent.click(screen.getByRole('button', { name: '切换' }))
    expect(region).toHaveAttribute('data-open', 'true')
    expect(region).toHaveAttribute('aria-hidden', 'false')
    expect(container.querySelector('#content')).not.toBeNull()
  })
})
