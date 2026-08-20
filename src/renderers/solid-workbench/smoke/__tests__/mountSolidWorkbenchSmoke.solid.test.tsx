// @vitest-environment jsdom
import { render, screen } from '@solidjs/testing-library'
import { afterEach, describe, expect, it } from 'vitest'
import { mountSolidWorkbenchSmoke } from '../mountSolidWorkbenchSmoke.solid.tsx'

const hosts: HTMLElement[] = []

afterEach(() => {
  for (const host of hosts.splice(0)) host.remove()
})

describe('mountSolidWorkbenchSmoke', () => {
  it('Solid component 可独立 mount/update/destroy', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    hosts.push(host)

    const lifecycle = mountSolidWorkbenchSmoke(host, { label: 'Solid', value: 1 })
    expect(screen.getByText('Solid')).toBeTruthy()

    lifecycle.update({ label: '更新后', value: 2 })
    expect(await screen.findByText('更新后')).toBeTruthy()
    expect(screen.getByText('2')).toBeTruthy()

    lifecycle.destroy()
    lifecycle.destroy()
    expect(host.childElementCount).toBe(0)
  })

  it('testing-library 能渲染隔离的 Solid JSX', () => {
    const result = render(() => <div data-testid="solid-direct">Solid direct</div>)
    expect(screen.getByTestId('solid-direct').textContent).toBe('Solid direct')
    result.unmount()
  })
})
