// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import FileTabBar from '../FileTabBar'
import { fileTabKey, type FileTabRecord } from '../fileSheetState'

describe('FileTabBar 版本化 tab（D-04：file/diff 统一 identity）', () => {
  const tabs: FileTabRecord[] = [
    { path: 'src/a.ts', mode: 'file' },
    { path: 'src/a.ts', mode: 'diff', staged: true },
    { path: 'src/b.ts', mode: 'file' },
  ]

  it('同路径 file/diff 并存为两个 tab（key 区分 mode，不互相覆盖）', () => {
    render(<FileTabBar tabs={tabs} activeKey={fileTabKey(tabs[0])} onSelect={() => {}} onClose={() => {}} />)
    const rendered = screen.getAllByRole('tab')
    expect(rendered).toHaveLength(3)
    expect(screen.getByTitle('src/a.ts')).toBeTruthy()
    expect(screen.getByTitle('src/a.ts（diff）')).toBeTruthy()
  })

  it('diff tab 带 mode 标记、staged 标签与 aria-selected；file tab 不误标 active', () => {
    render(<FileTabBar tabs={tabs} activeKey={fileTabKey(tabs[1])} onSelect={() => {}} onClose={() => {}} />)
    const diffTab = screen.getByTitle('src/a.ts（diff）')
    expect(diffTab.className).toContain('file-tab-diff')
    expect(diffTab.getAttribute('aria-selected')).toBe('true')
    expect(screen.getByText('staged')).toBeTruthy()
    expect(screen.getByTitle('src/a.ts').className).not.toContain('active')
  })

  it('点击 tab 以 key 回调 onSelect；关闭按钮以 key 回调 onClose 且不触发 select', () => {
    const onSelect = vi.fn()
    const onClose = vi.fn()
    render(<FileTabBar tabs={tabs} activeKey={null} onSelect={onSelect} onClose={onClose} />)
    fireEvent.click(screen.getByTitle('src/b.ts'))
    expect(onSelect).toHaveBeenCalledWith('file.text:src/b.ts')
    fireEvent.click(screen.getByLabelText('关闭 src/a.ts（diff）'))
    expect(onClose).toHaveBeenCalledWith('git.diff:src/a.ts')
    expect(onSelect).toHaveBeenCalledTimes(1)
  })

  it('无 tab 时渲染 null', () => {
    const { container } = render(<FileTabBar tabs={[]} activeKey={null} onSelect={() => {}} onClose={() => {}} />)
    expect(container.firstChild).toBeNull()
  })
})
