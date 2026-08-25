// @vitest-environment jsdom
import { cleanup, render, screen } from '@solidjs/testing-library'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { UnknownContentPart } from '../../../../../domains/workbench/content/contentPartSchema.ts'
import { BuiltinSolidContentSlot } from '../../BuiltinSolidContentSlot.solid.tsx'

afterEach(cleanup)

describe('content.unknown rich fallback', () => {
  it('keeps bounded evidence inspectable and routes resource fields through the command port', () => {
    const execute = vi.fn()
    const part: UnknownContentPart = {
      kind: 'unknown', originalType: 'provider.widget', summary: '未知 provider widget（已安全保留）',
      raw: { source_path: '/workspace/widget.ts', apiKey: '[REDACTED]', options: { mode: 'safe' } },
      truncated: true,
      truncation: { truncated: true, originalBytes: 4096, retainedBytes: 512, omittedBytes: 3584, reason: 'size-limit' },
      redactions: [{ path: ['apiKey'], reason: 'sensitive' }],
    }
    const { container } = render(() => <BuiltinSolidContentSlot
      snapshot={{ nodeId: 'unknown-1', kind: 'content.unknown', revision: 1, payload: part }}
      appearance={{}}
      commands={{ execute, canExecute: type => type === 'resource.open' }}
    />)

    const card = screen.getByRole('region', { name: '未知内容：provider.widget' })
    expect(card).toHaveAttribute('data-truncated', 'true')
    expect(card).toHaveTextContent('省略 3584 bytes')
    expect(card).toHaveTextContent('1 处敏感字段已隐藏')
    expect(container.querySelector('.solid-unknown-details')).not.toHaveAttribute('open')
    screen.getByRole('button', { name: '/workspace/widget.ts' }).click()
    expect(execute).toHaveBeenCalledWith({ type: 'resource.open', payload: { path: '/workspace/widget.ts' } })
  })
})
