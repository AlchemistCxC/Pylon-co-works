// @vitest-environment jsdom
import { cleanup, render, screen } from '@solidjs/testing-library'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BUILTIN_TEXT_RENDER_KINDS } from '../../../../../domains/rendererContent/textRenderKindCatalog.ts'
import { BuiltinSolidContentSlot } from '../../BuiltinSolidContentSlot.solid.tsx'

afterEach(cleanup)

const STRUCTURED_KINDS = [
  'content.location',
  'content.progress',
  'content.list',
  'content.key-value',
  'content.json',
  'content.tool-use',
  'content.tool-result',
] as const

function renderSlot(kind: (typeof STRUCTURED_KINDS)[number], payload: Record<string, unknown>, execute = vi.fn()) {
  const result = render(() => <BuiltinSolidContentSlot
    snapshot={{ nodeId: `structured:${kind}`, kind, revision: 1, payload }}
    appearance={{}}
    commands={{ execute, canExecute: type => type === 'resource.open' || type === 'clipboard.write' }}
  />)
  return { ...result, execute }
}

describe('first-class structured content', () => {
  it('opens a normalized location through the renderer command port', () => {
    const { execute } = renderSlot('content.location', {
      kind: 'location', path: '/workspace/src/app.ts', line: 12, column: 4,
    })

    expect(screen.getByRole('region', { name: '位置' })).toHaveTextContent('L12:C4')
    screen.getByRole('button', { name: '/workspace/src/app.ts' }).click()
    expect(execute).toHaveBeenCalledWith({
      type: 'resource.open',
      payload: { path: '/workspace/src/app.ts', range: { start: { line: 12, character: 4 } } },
    })
  })

  it('derives and clamps progress without exposing the provider envelope', () => {
    const { container } = renderSlot('content.progress', {
      kind: 'progress', current: 3, total: 4, message: '索引文件',
    })

    expect(screen.getByRole('region', { name: '进度' })).toHaveTextContent('索引文件75%')
    expect(screen.getByRole('progressbar', { name: '索引文件' })).toHaveAttribute('value', '75')
    expect(container.textContent).not.toContain('"current"')
  })

  it('renders canonical nested list parts through their rich presenters', () => {
    const { container } = renderSlot('content.list', {
      kind: 'list', title: '检查结果', items: [
        { kind: 'markdown', text: '**通过**' },
        { kind: 'code', text: 'const ok = true', language: 'ts' },
        { file_path: '/workspace/report.md', score: 0.98 },
      ],
    })

    expect(screen.getByRole('region', { name: '列表' })).toHaveTextContent('检查结果3 项')
    expect(screen.getByText('**通过**')).toBeTruthy()
    expect(container.querySelector('.term-code-block')).toHaveTextContent('const ok = true')
    expect(container.querySelector('.tool-object-inspector')).toHaveTextContent('/workspace/report.md')
  })

  it('uses the typed object inspector for key-value and json payloads', () => {
    const keyValue = renderSlot('content.key-value', {
      kind: 'key-value', entries: { model: 'gpt-5', retries: 2, enabled: true },
    })
    expect(keyValue.container.querySelector('.tool-object-inspector')).toHaveTextContent('model')
    expect(keyValue.container.querySelector('[data-primitive-type="number"]')).toHaveTextContent('2')
    keyValue.unmount()

    const json = renderSlot('content.json', {
      kind: 'json', value: { path: '/workspace/result.json', nested: { ok: true } },
    })
    expect(json.container.querySelector('.tool-object-inspector')).toHaveTextContent('nested')
    expect(json.container.querySelector('.solid-content-unknown')).toBeNull()
  })

  it('recursively renders tool-result parts and presents lifecycle metadata without JSON noise', () => {
    const { container } = renderSlot('content.tool-result', {
      kind: 'tool-result', name: 'Search', status: 'completed', latencyMs: 42,
      parts: [
        { kind: 'markdown', text: '找到 **2** 项' },
        { kind: 'location', path: '/workspace/a.ts', line: 7 },
      ],
    })

    expect(screen.getByRole('region', { name: '工具结果' })).toHaveTextContent('Search')
    expect(screen.getByRole('region', { name: '工具结果' })).toHaveTextContent('已完成')
    expect(screen.getByRole('region', { name: '工具结果' })).toHaveTextContent('42ms')
    expect(screen.getByText('找到 **2** 项')).toBeTruthy()
    expect(screen.getByRole('button', { name: '/workspace/a.ts' })).toBeTruthy()
    expect(screen.queryByRole('region', { name: '工具元数据' })).toBeNull()
    expect(container.textContent).not.toContain('"parts"')
  })

  it('keeps zero-duration metadata and an explicit output alongside rich result parts', () => {
    const { container } = renderSlot('content.tool-result', {
      kind: 'tool-result', name: 'Inspect', status: 'completed', latencyMs: 0,
      output: { cursor: 'next-page' },
      parts: [{ kind: 'markdown', text: '第一页' }],
    })

    expect(screen.getByRole('region', { name: '工具结果' })).toHaveTextContent('0ms')
    expect(screen.getByRole('region', { name: '工具输出' })).toHaveTextContent('next-page')
    expect(container.querySelector('.solid-structured-parts')).toHaveTextContent('第一页')
  })

  it('honors a non-HTTP URI carrier instead of reclassifying it as a filesystem path', () => {
    const { execute } = renderSlot('content.location', {
      kind: 'location', uri: 'acp-resource://server/spec', line: 3,
    })

    screen.getByRole('button', { name: 'acp-resource://server/spec' }).click()
    expect(execute).toHaveBeenCalledWith({
      type: 'resource.open',
      payload: { uri: 'acp-resource://server/spec', range: { start: { line: 3 } } },
    })
  })

  it('separates tool parameters from metadata and preserves non-canonical result values', () => {
    const toolUse = renderSlot('content.tool-use', {
      kind: 'tool-use', name: 'Fetch', input: { url: 'https://example.test', method: 'GET' }, requestId: 'r-1',
    })
    expect(screen.getByRole('region', { name: '工具参数' })).toHaveTextContent('https://example.test')
    expect(screen.getByRole('region', { name: '工具元数据' })).toHaveTextContent('requestId')
    toolUse.unmount()

    const result = renderSlot('content.tool-result', {
      kind: 'tool-result', name: 'Count', content: ['plain provider result', 3, true],
    })
    expect(result.container.querySelector('.solid-structured-parts')).toHaveTextContent('plain provider result3true')
  })

  it('registers every structured kind with a valid catalog fixture and a built-in rich route', () => {
    const catalog = new Map(BUILTIN_TEXT_RENDER_KINDS.map(kind => [kind.id, kind]))

    for (const kind of STRUCTURED_KINDS) {
      const definition = catalog.get(kind)
      expect(definition, kind).toBeDefined()
      expect(definition?.validateInput(definition.fixture), kind).toBe(true)
      const view = renderSlot(kind, definition?.fixture as Record<string, unknown>)
      expect(view.container.querySelector(`[data-content-kind="${kind}"] .solid-structured-content`), kind).not.toBeNull()
      expect(view.container.querySelector('.solid-content-unknown'), kind).toBeNull()
      view.unmount()
    }
  })
})
