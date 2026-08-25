// @vitest-environment jsdom
import { cleanup, render } from '@solidjs/testing-library'
import { afterEach, describe, expect, it } from 'vitest'
import { BuiltinSolidContentSlot } from '../BuiltinSolidContentSlot.solid.tsx'

afterEach(cleanup)

const commands = { execute: () => {} }

describe('BuiltinSolidContentSlot text appearance', () => {
  it('inherits ChatView size for defaults and applies only an explicit kind override', () => {
    const inherited = render(() => <BuiltinSolidContentSlot
      snapshot={{ nodeId: 'text-default', kind: 'content.markdown', revision: 1, payload: { text: '正文' } }}
      appearance={{ fontSize: 14 }} commands={commands}
    />)
    expect(inherited.container.querySelector<HTMLElement>('.solid-content-kind')?.style.fontSize).toBe('inherit')
    inherited.unmount()

    const overridden = render(() => <BuiltinSolidContentSlot
      snapshot={{ nodeId: 'text-override', kind: 'content.markdown', revision: 1, payload: { text: '正文' } }}
      appearance={{
        fontSize: 18,
        renderSettings: { sources: { kind: { fontSize: 'user-override' } } },
      }} commands={commands}
    />)
    expect(overridden.container.querySelector<HTMLElement>('.solid-content-kind')?.style.fontSize).toBe('18px')
  })
})
