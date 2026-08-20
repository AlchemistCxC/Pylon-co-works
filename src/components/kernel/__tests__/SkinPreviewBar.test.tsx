// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { SkinRuntime } from '../../../plugin-runtime/skin/skinRuntime'
import SkinPreviewBar from '../SkinPreviewBar'

function setup(runtime = new SkinRuntime()) {
  const draft = runtime.createDraft({ name: '测试皮肤', tokens: { accent: '#123456' } })
  const preview = runtime.preview(draft.draftId, { scope: 'global' })
  return { runtime, draft, preview }
}

describe('SkinPreviewBar（S5-D）', () => {
  it('无 active preview 时不渲染空壳', () => {
    const runtime = new SkinRuntime()
    const { container } = render(<SkinPreviewBar runtime={runtime} />)

    expect(container.querySelector('.skin-preview-bar')).toBeNull()
  })

  it('显示 preview 名称、目标、校验状态与 revision', () => {
    const { runtime, draft } = setup()

    render(<SkinPreviewBar runtime={runtime} />)

    expect(screen.getByText('测试皮肤')).toBeTruthy()
    expect(screen.getByText('全局')).toBeTruthy()
    expect(screen.getByText(`rev ${draft.revision}`)).toBeTruthy()
    expect(screen.getByRole('region', { name: 'Skin 预览' })).toHaveAttribute('data-skin-preview-id')
  })

  it('继续调整通过 SkinRuntime.patchDraft 生效，不直改 Store', () => {
    const { runtime, draft } = setup()

    render(<SkinPreviewBar runtime={runtime} />)
    fireEvent.change(screen.getByLabelText('Skin patch JSON'), {
      target: { value: '{"tokens":{"accent":"#ff0000"}}' },
    })
    fireEvent.click(screen.getByText('继续调整'))

    expect(runtime.getDraft(draft.draftId)?.tokens.accent).toBe('#ff0000')
    expect(screen.getByText(`rev ${runtime.getDraft(draft.draftId)?.revision}`)).toBeTruthy()
  })

  it('撤销预览调用 rollback，Bar 消失', () => {
    const { runtime } = setup()

    const { container } = render(<SkinPreviewBar runtime={runtime} />)
    fireEvent.click(screen.getByText('撤销预览'))

    expect(container.querySelector('.skin-preview-bar')).toBeNull()
    expect(runtime.getSnapshot().activePreview).toBeNull()
  })

  it('确认应用需要 confirm gate；确认后 commit 并消失', () => {
    const { runtime, preview } = setup()
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)

    const { container } = render(<SkinPreviewBar runtime={runtime} />)
    fireEvent.click(screen.getByText('确认应用'))

    expect(confirm).toHaveBeenCalledOnce()
    expect(container.querySelector('.skin-preview-bar')).toBeNull()
    expect(runtime.getSnapshot().committedSkinCount).toBe(1)
    expect(runtime.getBindingSkinId(preview.target)).toBe(`skin-${preview.draftId}`)
    confirm.mockRestore()
  })

  it('confirm 取消时保持 preview，不 commit', () => {
    const { runtime } = setup()
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)

    render(<SkinPreviewBar runtime={runtime} />)
    fireEvent.click(screen.getByText('确认应用'))

    expect(runtime.getSnapshot().committedSkinCount).toBe(0)
    expect(runtime.getSnapshot().activePreview).not.toBeNull()
    confirm.mockRestore()
  })
})
