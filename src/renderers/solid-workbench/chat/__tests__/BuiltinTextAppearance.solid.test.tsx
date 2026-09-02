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

  it('lets reasoning schema defaults inherit conversation typography while preserving direct overrides', () => {
    const inherited = render(() => <BuiltinSolidContentSlot
      snapshot={{ nodeId: 'reasoning-default', kind: 'content.reasoning', revision: 1, payload: { text: '思考', state: 'complete' } }}
      appearance={{
        fontSize: 13,
        lineHeight: 1.6,
        renderSettings: { sources: { kind: { fontSize: 'kind-default', lineHeight: 'kind-default' } } },
      }}
      commands={commands}
    />)
    const inheritedNode = inherited.container.querySelector<HTMLElement>('.solid-content-kind')!
    expect(inheritedNode.style.fontSize).toBe('inherit')
    expect(inheritedNode.style.lineHeight).toBe('inherit')
    inherited.unmount()

    const direct = render(() => <BuiltinSolidContentSlot
      snapshot={{ nodeId: 'reasoning-direct', kind: 'content.reasoning', revision: 1, payload: { text: '思考', state: 'complete' } }}
      appearance={{ fontSize: 16, lineHeight: 1.7 }}
      commands={commands}
    />)
    const directNode = direct.container.querySelector<HTMLElement>('.solid-content-kind')!
    expect(directNode.style.fontSize).toBe('16px')
    expect(directNode.style.lineHeight).toBe('1.7')
  })

  it('keeps ordinary text on the message rail even when a legacy slot sends mono', () => {
    const result = render(() => <BuiltinSolidContentSlot
      snapshot={{ nodeId: 'text-mono-legacy', kind: 'content.markdown', revision: 1, payload: { text: '普通英文 should follow chat font' } }}
      appearance={{ fontFamily: 'mono', fontSize: 14, lineHeight: 1.6 }}
      commands={commands}
    />)
    expect(result.container.querySelector<HTMLElement>('.solid-content-kind')?.style.fontFamily).toBe('inherit')
  })
})
