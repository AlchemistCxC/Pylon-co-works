// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import PetCompanion from '../PetCompanion.tsx'

// 下沉自 scripts/test-pet-transparent-shell.mts（P91 A2）：
// 宠物状态/衣橱面板只能按需展开；宠物本体有贴合交互外壳。
// （手势/双击窗口纯函数由 petMotion.test.ts 承担；透明壳 CSS 由 css 断言守卫。）

vi.mock('@tauri-apps/api/core', async () => {
  const { tauriCoreMock } = await import('../../test-utils/tauriCoreMock')
  return tauriCoreMock(() => Promise.resolve(null))
})
vi.mock('../../infrastructure/tauri/env.ts', () => ({ IS_TAURI: false, hasTauriRuntime: () => false }))

describe('PetCompanion 按需面板', () => {
  afterEach(async () => {
    const { cleanup } = await import('@testing-library/react')
    cleanup()
  })

  it('面板默认收起，点击开关展开（不常驻）', () => {
    const { container } = render(<PetCompanion />)
    expect(container.querySelector('.pet-panel')).toBeNull()
    const toggle = screen.getByRole('button', { name: '打开宠物状态与衣橱' })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(toggle)
    expect(container.querySelector('.pet-panel')).not.toBeNull()
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
  })

  it('宠物本体有贴合点击范围的交互外壳', () => {
    const { container } = render(<PetCompanion />)
    expect(container.querySelector('.pet-creature-hitbox')).not.toBeNull()
  })
})
