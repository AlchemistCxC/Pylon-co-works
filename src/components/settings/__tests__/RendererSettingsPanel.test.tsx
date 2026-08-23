// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import RendererSettingsPanel from '../RendererSettingsPanel.tsx'
import { createRendererSettingsStore } from '../../../plugin-runtime/renderers/rendererSettingsStore.ts'
import type { RendererSettingsSchema } from '../../../plugin-runtime/renderers/rendererSettingsTypes.ts'

const schema: RendererSettingsSchema = {
  schemaVersion: 1,
  groups: [{ id: 'main', label: '主要表现', fields: [
    { key: 'style', label: '消息风格', type: 'choice', presentation: 'radio', options: [{ value: 'compact', label: '紧凑' }, { value: 'roomy', label: '宽松' }], default: 'compact' },
    { key: 'parts', label: '内容块', type: 'multi-choice', presentation: 'checklist', options: [{ value: 'text', label: '文本' }, { value: 'code', label: '代码' }] },
    { key: 'accent', label: '强调色', type: 'color', presentation: 'picker', default: '#3366ff' },
    { key: 'scale', label: '字号', type: 'number', presentation: 'slider+input', min: 10, max: 30, default: 16 },
    { key: 'enabled', label: '启用', type: 'boolean', presentation: 'toggle', default: true },
    { key: 'note', label: '备注', type: 'text', presentation: 'textarea', showIf: { equals: { field: 'enabled', value: true } } },
  ] }],
}

describe('RendererSettingsPanel', () => {
  it('渲染声明控件，用户操作写入 renderer namespace 并支持条件字段', () => {
    const store = createRendererSettingsStore({ storage: undefined })
    render(<RendererSettingsPanel schemas={[{ id: 'content.markdown', label: 'Markdown', schema }]} store={store} />)
    expect(screen.getByLabelText('消息风格')).toBeTruthy()
    expect(screen.getByLabelText('内容块')).toBeTruthy()
    expect(screen.getByLabelText('强调色')).toBeTruthy()
    expect(screen.getByLabelText('字号')).toBeTruthy()
    expect(screen.getByLabelText('启用')).toBeTruthy()
    expect(screen.getByLabelText('备注')).toBeTruthy()
    // S4 迁移（施工书 06 §S4）：radio 声明现按语义渲染为 radio 组（设计书 §3.1 分发矩阵），
    // change→click；值写入语义不变。
    fireEvent.click(screen.getByRole('radio', { name: '宽松' }))
    expect(store.getSnapshot().values['kind.content.markdown.style']).toBe('roomy')
    fireEvent.click(screen.getByLabelText('启用'))
    expect(screen.queryByLabelText('备注')).toBeNull()
  })

  it('搜索命中 option label，并显示 unavailable 值可恢复', () => {
    const store = createRendererSettingsStore({ storage: undefined })
    store.markUnavailable('kind.content.markdown.legacy', 'old')
    render(<RendererSettingsPanel search="宽松" schemas={[{ id: 'content.markdown', label: 'Markdown', schema }]} store={store} />)
    expect(screen.getByText('宽松')).toBeTruthy()
    expect(screen.getByText(/kind\.content\.markdown\.legacy.*不可用/)).toBeTruthy()
  })
})

describe('S3 组级 layout 契约', () => {
  it('group.layout=grid 时组容器携带 layout-grid class', () => {
    const store = createRendererSettingsStore({ storage: undefined })
    const schemaWithLayout: RendererSettingsSchema = {
      schemaVersion: 1,
      groups: [{ id: 'g1', label: '网格组', layout: 'grid', fields: [
        { key: 'n', label: '数字', type: 'number', min: 0, max: 9, default: 1 },
      ] }],
    }
    render(<RendererSettingsPanel schemas={[{ id: 'x.y', label: 'X', schema: schemaWithLayout }]} store={store} />)
    expect(document.querySelector('.renderer-settings-group.layout-grid')).toBeTruthy()
  })
})
